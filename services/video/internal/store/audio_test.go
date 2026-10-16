package store

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/services/video/internal/domain"
	"github.com/luantpbk/winkey/services/video/internal/testutil"
)

// seedTrack inserts an audio track as upload-svc and the transcoder would leave it.
func seedTrack(t *testing.T, pool *pgxpool.Pool, videoID uuid.UUID, lang, kind, status string, isDefault bool) uuid.UUID {
	t.Helper()
	id := ids.New()
	var playlist *string
	if status == domain.StatusReady {
		p := "v/" + videoID.String() + "/a2/audio/" + id.String() + "/index.m3u8"
		playlist = &p
	}
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO media.video_audio_tracks
			(id, video_id, lang, label, kind, is_default, status, raw_bucket, raw_key, content_type, size_bytes, playlist_key)
		VALUES ($1, $2, $3, $4, $5, $6, $7, 'winkey-raw', 'k', 'audio/flac', 100, $8)`,
		id, videoID, lang, "label "+lang, kind, isDefault, status, playlist); err != nil {
		t.Fatal(err)
	}
	return id
}

// rewriter records its calls and hands out new keys.
type rewriter struct {
	mu    sync.Mutex
	calls [][]domain.AudioTrack
	err   error
}

func (r *rewriter) fn(_ context.Context, _ uuid.UUID, masterKey string, ready []domain.AudioTrack) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.err != nil {
		return "", r.err
	}
	r.calls = append(r.calls, ready)
	return masterKey + ".v" + ids.NewString(), nil
}

func masterKeyOf(t *testing.T, pool *pgxpool.Pool, id uuid.UUID) string {
	t.Helper()
	var k string
	if err := pool.QueryRow(context.Background(), `SELECT hls_master_key FROM media.videos WHERE id = $1`, id).Scan(&k); err != nil {
		t.Fatal(err)
	}
	return k
}

func TestAudioTracksListLoadUpdateDelete(t *testing.T) {
	st, pg := setup(t)
	ctx := context.Background()
	owner := testutil.SeedUser(t, pg.Pool, "alice", nil, "")
	v := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: owner.ID})

	vi := seedTrack(t, pg.Pool, v.ID, "vi", "voiceover", domain.StatusReady, true)
	en := seedTrack(t, pg.Pool, v.ID, "en", "dub", domain.StatusReady, false)
	up := seedTrack(t, pg.Pool, v.ID, "en", "commentary", domain.StatusUploading, false)

	all, err := st.ListAudioTracks(ctx, v.ID)
	if err != nil || len(all) != 3 || all[0].ID != up || all[1].ID != en || all[2].ID != vi {
		t.Fatalf("list: %+v %v", all, err)
	}
	got, err := st.GetVideo(ctx, v.ID)
	if err != nil || len(got.AudioTracks) != 2 || got.AudioTracks[0].ID != en || got.AudioTracks[1].PlaylistKey == "" {
		t.Fatalf("GetVideo audio: %+v %v", got.AudioTracks, err)
	}

	// Rename + make default: one rewrite with the READY tracks after the change, the default moved.
	rw := &rewriter{}
	before := masterKeyOf(t, pg.Pool, v.ID)
	label := "English dub"
	tr, err := st.UpdateAudioTrack(ctx, v.ID, en, domain.AudioTrackUpdate{Label: &label, MakeDefault: true}, rw.fn)
	if err != nil || tr.Label != label || !tr.IsDefault {
		t.Fatalf("update: %+v %v", tr, err)
	}
	if len(rw.calls) != 1 || len(rw.calls[0]) != 2 || !rw.calls[0][0].IsDefault || rw.calls[0][1].IsDefault {
		t.Fatalf("rewrite saw %+v", rw.calls)
	}
	after := masterKeyOf(t, pg.Pool, v.ID)
	if after == before {
		t.Fatal("hls_master_key not updated")
	}

	// A failing rewrite rolls the change back.
	rw.err = errors.New("garage down")
	other := "x"
	if _, err := st.UpdateAudioTrack(ctx, v.ID, vi, domain.AudioTrackUpdate{Label: &other}, rw.fn); err == nil {
		t.Fatal("update succeeded although the rewrite failed")
	}
	rw.err = nil
	if all, _ := st.ListAudioTracks(ctx, v.ID); all[2].Label != "label vi" || masterKeyOf(t, pg.Pool, v.ID) != after {
		t.Fatalf("not rolled back: %+v", all[2])
	}

	// Delete: UPLOADING refused, unknown and foreign ids are ErrNotFound.
	if _, err := st.DeleteAudioTrack(ctx, v.ID, up, rw.fn); !errors.Is(err, domain.ErrAudioTrackUploading) {
		t.Fatalf("delete uploading: %v", err)
	}
	if _, err := st.DeleteAudioTrack(ctx, v.ID, ids.New(), rw.fn); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("delete unknown: %v", err)
	}
	v2 := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: owner.ID})
	if _, err := st.DeleteAudioTrack(ctx, v2.ID, vi, rw.fn); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("delete through another video: %v", err)
	}
	calls := len(rw.calls)
	del, err := st.DeleteAudioTrack(ctx, v.ID, vi, rw.fn)
	if err != nil || del.ID != vi || del.PlaylistKey == "" {
		t.Fatalf("delete: %+v %v", del, err)
	}
	if len(rw.calls) != calls+1 || len(rw.calls[calls]) != 1 || rw.calls[calls][0].ID != en {
		t.Fatalf("rewrite after delete saw %+v", rw.calls[calls:])
	}
}

// A video without READY tracks never needs a master rewrite (renaming a track that is still processing).
func TestAudioTrackUpdateWithoutReadyTracksSkipsRewrite(t *testing.T) {
	st, pg := setup(t)
	ctx := context.Background()
	owner := testutil.SeedUser(t, pg.Pool, "alice", nil, "")
	v := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: owner.ID})
	tr := seedTrack(t, pg.Pool, v.ID, "vi", "dub", domain.StatusProcessing, false)
	rw := &rewriter{}
	label := "y"
	if _, err := st.UpdateAudioTrack(ctx, v.ID, tr, domain.AudioTrackUpdate{Label: &label, MakeDefault: true}, rw.fn); err != nil {
		t.Fatal(err)
	}
	if len(rw.calls) != 0 {
		t.Fatalf("rewrite called %d times", len(rw.calls))
	}
}

func TestSubtitleKindRoundTrip(t *testing.T) {
	st, pg := setup(t)
	ctx := context.Background()
	owner := testutil.SeedUser(t, pg.Pool, "alice", nil, "")
	v := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: owner.ID})
	w := sw(v, "vi")
	w.Kind = "captions"
	res, err := st.PutSubtitle(ctx, w)
	if err != nil || res.Track.Kind != "captions" {
		t.Fatalf("%+v %v", res, err)
	}
	got, err := st.GetVideo(ctx, v.ID)
	if err != nil || len(got.Subtitles) != 1 || got.Subtitles[0].Kind != "captions" {
		t.Fatalf("%+v %v", got.Subtitles, err)
	}
}

// A video with an AV1 set (ENC2, ADR-041): every audio change rewrites both masters in the same transaction.
func TestAudioTrackChangeRewritesAV1Master(t *testing.T) {
	st, pg := setup(t)
	ctx := context.Background()
	owner := testutil.SeedUser(t, pg.Pool, "alice", nil, "")
	v := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: owner.ID})
	av1 := "v/" + v.ID.String() + "/av1/r1/master.m3u8"
	if _, err := pg.Pool.Exec(ctx, `UPDATE media.videos SET hls_av1_master_key = $2 WHERE id = $1`, v.ID, av1); err != nil {
		t.Fatal(err)
	}
	av1Of := func() string {
		var k string
		_ = pg.Pool.QueryRow(ctx, `SELECT hls_av1_master_key FROM media.videos WHERE id = $1`, v.ID).Scan(&k)
		return k
	}
	vi := seedTrack(t, pg.Pool, v.ID, "vi", "voiceover", domain.StatusReady, true)
	h264 := masterKeyOf(t, pg.Pool, v.ID)

	rw := &rewriter{}
	label := "Tiếng Việt"
	if _, err := st.UpdateAudioTrack(ctx, v.ID, vi, domain.AudioTrackUpdate{Label: &label}, rw.fn); err != nil {
		t.Fatal(err)
	}
	newAV1 := av1Of()
	if len(rw.calls) != 2 || masterKeyOf(t, pg.Pool, v.ID) == h264 || newAV1 == av1 || !strings.HasPrefix(newAV1, av1+".v") ||
		rw.calls[1][0].Label != label {
		t.Fatalf("calls %+v, av1 %s", rw.calls, newAV1)
	}

	// A failing AV1 rewrite rolls everything back, the H.264 master included.
	h264 = masterKeyOf(t, pg.Pool, v.ID)
	n := 0
	half := func(ctx context.Context, id uuid.UUID, key string, ready []domain.AudioTrack) (string, error) {
		if n++; n == 2 {
			return "", errors.New("garage down")
		}
		return rw.fn(ctx, id, key, ready)
	}
	if _, err := st.DeleteAudioTrack(ctx, v.ID, vi, half); err == nil {
		t.Fatal("delete succeeded although the AV1 rewrite failed")
	}
	if masterKeyOf(t, pg.Pool, v.ID) != h264 || av1Of() != newAV1 {
		t.Fatal("not rolled back")
	}
	if all, _ := st.ListAudioTracks(ctx, v.ID); len(all) != 1 {
		t.Fatalf("track deleted: %+v", all)
	}
}
