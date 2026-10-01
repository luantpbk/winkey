package store

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/services/video/internal/domain"
	"github.com/luantpbk/winkey/services/video/internal/testutil"
)

// One statement for the whole batch, whatever the number of videos; unknown ids are simply absent; the owner is
// flagged missing when the profile view has no row for it (suspended or deleted).
func TestVideosForPlaybackIsOneQuery(t *testing.T) {
	_, pg := setup(t)
	ctx := context.Background()
	alice := testutil.SeedUser(t, pg.Pool, "alice", nil, "")
	ghost := testutil.SeedUser(t, pg.Pool, "ghost", nil, "SUSPENDED")
	var vids []uuid.UUID
	for i := 0; i < 15; i++ {
		vids = append(vids, testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: alice.ID}).ID)
	}
	private := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: alice.ID, Visibility: "PRIVATE"}).ID
	hidden := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: alice.ID, Hidden: true}).ID
	proc := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: alice.ID, Status: "PROCESSING", Attempts: []float32{5}}).ID
	orphan := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: ghost.ID}).ID
	ask := append(append([]uuid.UUID{}, vids...), private, hidden, proc, orphan, ids.New(), ids.New())

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

	got, err := st.VideosForPlayback(ctx, ask)
	if err != nil {
		t.Fatal(err)
	}
	if n := len(tr.all()); n != 1 {
		t.Fatalf("%d statements for %d ids: %v", n, len(ask), tr.all())
	}
	if len(got) != len(vids)+4 { // the two unknown ids are absent
		t.Fatalf("%d videos", len(got))
	}
	by := map[uuid.UUID]domain.Video{}
	for _, v := range got {
		by[v.ID] = v
	}
	if v := by[private]; v.Visibility != domain.VisPrivate || v.Status != domain.StatusReady || v.OwnerID != alice.ID || v.Owner.Missing {
		t.Fatalf("private: %+v", v)
	}
	if v := by[hidden]; !v.Hidden() {
		t.Fatalf("hidden: %+v", v)
	}
	if v := by[proc]; v.Status != domain.StatusProcessing {
		t.Fatalf("processing: %+v", v)
	}
	if v := by[orphan]; !v.Owner.Missing || v.OwnerID != ghost.ID {
		t.Fatalf("a video of a suspended owner: %+v", v)
	}
	if got, err := st.VideosForPlayback(ctx, nil); err != nil || got != nil {
		t.Fatalf("no ids: %v %v", got, err)
	}
}
