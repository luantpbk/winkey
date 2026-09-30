package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/services/video/internal/domain"
	"github.com/luantpbk/winkey/services/video/internal/testutil"
)

func sw(v testutil.Video, lang string) domain.SubtitleWrite {
	return domain.SubtitleWrite{VideoID: v.ID, Lang: lang, Label: "label " + lang,
		ObjectKey: fmt.Sprintf("v/%s/subtitles/%s-%s.vtt", v.ID, lang, ids.NewString()), SizeBytes: 40}
}

func TestPutSubtitleUpsertLimitAndStatus(t *testing.T) {
	st, pg := setup(t)
	ctx := context.Background()
	owner := testutil.SeedUser(t, pg.Pool, "alice", nil, "")
	v := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: owner.ID})

	first, err := st.PutSubtitle(ctx, sw(v, "vi"))
	if err != nil || !first.Created || first.PreviousKey != "" || first.Track.Source != "UPLOAD" || first.Track.UpdatedAt.IsZero() {
		t.Fatalf("create: %+v %v", first, err)
	}
	w2 := sw(v, "vi")
	second, err := st.PutSubtitle(ctx, w2)
	if err != nil || second.Created || second.PreviousKey != w2.ObjectKey && second.PreviousKey != first.Track.ObjectKey ||
		second.Track.ObjectKey != w2.ObjectKey || !second.Track.UpdatedAt.After(first.Track.UpdatedAt) {
		t.Fatalf("replace: %+v %v", second, err)
	}
	if second.PreviousKey != first.Track.ObjectKey {
		t.Fatalf("PreviousKey %s, want the replaced object %s", second.PreviousKey, first.Track.ObjectKey)
	}

	// 19 more languages: 20 in all; the 21st is refused, replacing is not.
	for i := 1; i < domain.MaxSubtitles; i++ {
		if _, err := st.PutSubtitle(ctx, sw(v, fmt.Sprintf("a%c", 'a'+i))); err != nil {
			t.Fatalf("language %d: %v", i, err)
		}
	}
	if _, err := st.PutSubtitle(ctx, sw(v, "zz")); !errors.Is(err, domain.ErrTooManySubtitles) {
		t.Fatalf("21st language: %v", err)
	}
	if r, err := st.PutSubtitle(ctx, sw(v, "vi")); err != nil || r.Created {
		t.Fatalf("replace at the limit: %+v %v", r, err)
	}
	var n int
	_ = pg.Pool.QueryRow(ctx, `SELECT count(*) FROM media.video_subtitles WHERE video_id=$1`, v.ID).Scan(&n)
	if n != 20 {
		t.Fatalf("%d rows", n)
	}

	// Another video has its own 20; unknown video; FAILED video.
	other := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: owner.ID})
	if _, err := st.PutSubtitle(ctx, sw(other, "zz")); err != nil {
		t.Fatalf("other video: %v", err)
	}
	ghost := testutil.Video{ID: ids.New()}
	if _, err := st.PutSubtitle(ctx, sw(ghost, "vi")); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("unknown video: %v", err)
	}
	failed := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: owner.ID, Status: "FAILED", Error: "boom"})
	if _, err := st.PutSubtitle(ctx, sw(failed, "vi")); !errors.Is(err, domain.ErrVideoFailed) {
		t.Fatalf("FAILED video: %v", err)
	}
	processing := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: owner.ID, Status: "PROCESSING", Attempts: []float32{5}})
	if _, err := st.PutSubtitle(ctx, sw(processing, "vi")); err != nil {
		t.Fatalf("PROCESSING video: %v", err)
	}

	// DeleteSubtitle returns the key, then the track is gone.
	key, err := st.DeleteSubtitle(ctx, other.ID, "zz")
	if err != nil || !strings.Contains(key, "/subtitles/zz-") {
		t.Fatalf("delete: %q %v", key, err)
	}
	if _, err := st.DeleteSubtitle(ctx, other.ID, "zz"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("second delete: %v", err)
	}
}

// The database enforces what the API promises: one row per language, a valid tag and label, a key under v/…/subtitles/.
func TestSubtitleTableConstraints(t *testing.T) {
	_, pg := setup(t)
	ctx := context.Background()
	owner := testutil.SeedUser(t, pg.Pool, "alice", nil, "")
	v := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: owner.ID})
	ins := func(lang, label, key string, size int) error {
		_, err := pg.Pool.Exec(ctx, `INSERT INTO media.video_subtitles (video_id, lang, label, object_key, size_bytes) VALUES ($1,$2,$3,$4,$5)`, v.ID, lang, label, key, size)
		return err
	}
	good := "v/" + v.ID.String() + "/subtitles/vi-x.vtt"
	if err := ins("vi", "ok", good, 10); err != nil {
		t.Fatal(err)
	}
	for name, err := range map[string]error{
		"duplicate language": ins("vi", "ok", good, 10),
		"bad tag":            ins("VI", "ok", good, 10),
		"empty label":        ins("en", "", good, 10),
		"label over 50":      ins("en", strings.Repeat("x", 51), good, 10),
		"key outside":        ins("en", "ok", "somewhere/else.vtt", 10),
		"size 0":             ins("en", "ok", good, 0),
		"size over limit":    ins("en", "ok", good, 524289),
	} {
		if err == nil {
			t.Errorf("%s accepted", name)
		}
	}
}

// Playback needs the tracks of a video with ONE query, and none when the video is not READY.
func TestGetVideoLoadsSubtitlesWithOneQuery(t *testing.T) {
	_, pg := setup(t)
	ctx := context.Background()
	owner := testutil.SeedUser(t, pg.Pool, "alice", nil, "")
	ready := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: owner.ID})
	proc := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: owner.ID, Status: "PROCESSING", Attempts: []float32{5}})

	cfg, err := pgxpool.ParseConfig(pg.URL)
	if err != nil {
		t.Fatal(err)
	}
	tr := &sqlLog{}
	cfg.ConnConfig.Tracer = tr
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	st := &Postgres{Pool: pool}
	for _, l := range []string{"vi", "en-US", "en", "fr", "zz"} {
		if _, err := st.PutSubtitle(ctx, sw(ready, l)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := st.PutSubtitle(ctx, sw(proc, "vi")); err != nil {
		t.Fatal(err)
	}

	tr.reset()
	v, err := st.GetVideo(ctx, ready.ID)
	if err != nil {
		t.Fatal(err)
	}
	var langs []string
	for _, s := range v.Subtitles {
		langs = append(langs, s.Lang)
	}
	if strings.Join(langs, ",") != "en,en-US,fr,vi,zz" { // bytewise, whatever the collation
		t.Fatalf("order %v", langs)
	}
	if n := tr.count("video_subtitles"); n != 1 {
		t.Fatalf("%d statements read video_subtitles, want 1: %v", n, tr.all())
	}
	if total := len(tr.all()); total != 3 { // the video, its renditions, its subtitles
		t.Fatalf("%d statements: %v", total, tr.all())
	}

	// Not READY: no playback, so no query for tracks; the slice is empty, not nil.
	tr.reset()
	p, err := st.GetVideo(ctx, proc.ID)
	if err != nil || p.Subtitles == nil || len(p.Subtitles) != 0 || tr.count("video_subtitles") != 0 {
		t.Fatalf("processing: %+v %v %v", p.Subtitles, err, tr.all())
	}
}

type sqlLog struct {
	mu   sync.Mutex
	sqls []string
}

func (s *sqlLog) TraceQueryStart(ctx context.Context, _ *pgx.Conn, d pgx.TraceQueryStartData) context.Context {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sqls = append(s.sqls, d.SQL)
	return ctx
}
func (s *sqlLog) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}
func (s *sqlLog) reset()                                                          { s.mu.Lock(); s.sqls = nil; s.mu.Unlock() }
func (s *sqlLog) all() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.sqls...)
}
func (s *sqlLog) count(sub string) int {
	n := 0
	for _, q := range s.all() {
		if strings.Contains(q, sub) {
			n++
		}
	}
	return n
}
