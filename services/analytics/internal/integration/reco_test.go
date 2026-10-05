package integration

import (
	"context"
	"fmt"
	"math"
	"reflect"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/luantpbk/winkey/libs/go/testkit"
	"github.com/luantpbk/winkey/services/analytics/internal/chdb"
	"github.com/luantpbk/winkey/services/analytics/internal/event"
	"github.com/luantpbk/winkey/services/analytics/internal/migrate"
	"github.com/luantpbk/winkey/services/analytics/internal/reco"
)

func TestRecoQualificationReplacementAndRollback(t *testing.T) {
	ctx := context.Background()
	ch := testkit.StartClickHouse(t)
	conn, err := chdb.Open(chdb.Options{Addr: ch.Addr, User: "default"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	if _, err := migrate.Apply(ctx, chdb.Migrations{Conn: conn}, migrationsDir(t), quiet()); err != nil {
		t.Fatal(err)
	}
	pg := testkit.StartPostgres(t)
	now := time.Now().UTC().Truncate(time.Second)
	a, b, c := vidA1, vidA2, vidB1
	var raw []event.Row
	add := func(viewer int, video uuid.UUID, watched uint32, when time.Time) {
		id := uuid.NewSHA1(uuid.NameSpaceOID, []byte(fmt.Sprintf("reco-%d", len(raw))))
		raw = append(raw, event.Row{EventID: id, PlaybackID: id, VideoID: video, OwnerID: ownerA,
			ViewerKey: viewerKey(viewer), Authenticated: viewer != 3, ReceivedAt: when, SentAt: when,
			Kind: "heartbeat", Client: "web", WatchedMs: watched})
	}
	for viewer := 1; viewer <= 3; viewer++ {
		add(viewer, a, 10000, now.Add(-2*time.Hour))
		add(viewer, a, 10000, now.Add(-time.Hour))
		add(viewer, b, 20000, now.Add(-30*time.Minute))
		if viewer <= 2 {
			add(viewer, c, 20000, now.Add(-10*time.Minute))
		}
	}
	add(4, a, 20000, now.Add(-time.Hour))    // denominators A=4, B=3; co=3
	add(5, b, 10000, now.Add(-time.Hour))    // duplicating this must not qualify
	add(6, b, 20000, now.AddDate(0, 0, -31)) // outside window
	add(7, b, 20000, now.Add(time.Hour))     // after run cutoff
	ins := &chdb.Inserter{Conn: conn}
	if err := ins.InsertBatch(ctx, raw, "reco-fixture"); err != nil {
		t.Fatal(err)
	}
	// Different block token deliberately bypasses block deduplication: FINAL must do the work.
	if err := ins.InsertBatch(ctx, raw, "reco-duplicates"); err != nil {
		t.Fatal(err)
	}
	src := &reco.ClickHouse{Conn: conn}
	opts := reco.Options{WindowDays: 30, MinWatchMs: 20000, Neighbors: 30, History: 50, CoviewMax: 200}
	pairs, history, _, err := src.Read(ctx, now, opts)
	if err != nil {
		t.Fatal(err)
	}
	if len(pairs) != 2 {
		t.Fatalf("pairs: %+v", pairs)
	}
	for i, ids := range [][2]uuid.UUID{{a, b}, {b, a}} {
		p := pairs[i]
		if p.VideoID != ids[0] || p.NeighborID != ids[1] || p.CoViewers != 3 || math.Abs(p.Score-3/math.Sqrt(12)) > 1e-6 {
			t.Fatalf("pair: %+v", p)
		}
	}
	want := []reco.Watch{}
	for _, viewer := range []int{1, 2, 4} {
		if viewer <= 2 {
			want = append(want, reco.Watch{ViewerKey: viewerKey(viewer), VideoID: c, LastWatchedAt: now.Add(-10 * time.Minute), WatchedMs: 20000}, reco.Watch{ViewerKey: viewerKey(viewer), VideoID: b, LastWatchedAt: now.Add(-30 * time.Minute), WatchedMs: 20000})
		}
		want = append(want, reco.Watch{ViewerKey: viewerKey(viewer), VideoID: a, LastWatchedAt: now.Add(-time.Hour), WatchedMs: 20000})
	}
	if !reflect.DeepEqual(history, want) {
		t.Fatalf("history got %+v want %+v", history, want)
	}
	limited := opts
	limited.History = 1
	_, recent, _, err := src.Read(ctx, now, limited)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(recent, []reco.Watch{want[0], want[3], want[6]}) {
		t.Fatalf("most recent per viewer: %+v", recent)
	}
	sink := &reco.Postgres{Pool: pg.Pool}
	if err := sink.Replace(ctx, pairs, history, now); err != nil {
		t.Fatal(err)
	}
	assertRecoProjection(t, pg, pairs, history, now)
	// Fail the SECOND COPY after first COPY succeeded: both old tables must survive intact.
	bad := append([]reco.Watch(nil), history...)
	bad[0].WatchedMs = -1
	if err := sink.Replace(ctx, pairs[:1], bad, now.Add(time.Minute)); err == nil {
		t.Fatal("invalid history COPY succeeded")
	}
	assertRecoProjection(t, pg, pairs, history, now)
	// Changed data/window: only the last ten minutes remain, no co-view pairs; history is replaced.
	if err := conn.Exec(ctx, `ALTER TABLE winkey.playback_events DELETE WHERE received_at < ? SETTINGS mutations_sync=1`, now.Add(-20*time.Minute)); err != nil {
		t.Fatal(err)
	}
	pairs, history, _, err = src.Read(ctx, now.Add(time.Minute), opts)
	if err != nil {
		t.Fatal(err)
	}
	if len(pairs) != 0 || len(history) != 2 {
		t.Fatalf("second projection: %+v %+v", pairs, history)
	}
	if err := sink.Replace(ctx, pairs, history, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	assertRecoProjection(t, pg, pairs, history, now.Add(time.Minute))
	if err := sink.Replace(ctx, nil, nil, now); err != nil {
		t.Fatal(err)
	}
	assertRecoProjection(t, pg, nil, nil, now)

	// Three tied neighbors: each video's independent top-N uses neighbor UUID ascending.
	if err := conn.Exec(ctx, `TRUNCATE TABLE winkey.playback_events`); err != nil {
		t.Fatal(err)
	}
	raw = nil
	for viewer := 1; viewer <= 3; viewer++ {
		for _, video := range []uuid.UUID{a, b, c} {
			add(viewer, video, 20000, now.Add(-time.Minute))
		}
	}
	if err := ins.InsertBatch(ctx, raw, "reco-ties"); err != nil {
		t.Fatal(err)
	}
	limited.Neighbors = 1
	pairs, _, _, err = src.Read(ctx, now, limited)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(pairs, []reco.Pair{{VideoID: a, NeighborID: b, CoViewers: 3, Score: 1}, {VideoID: b, NeighborID: a, CoViewers: 3, Score: 1}, {VideoID: c, NeighborID: a, CoViewers: 3, Score: 1}}) {
		t.Fatalf("top neighbors with ties: %+v", pairs)
	}
}

func assertRecoProjection(t *testing.T, pg *testkit.Postgres, pairs []reco.Pair, history []reco.Watch, refreshed time.Time) {
	t.Helper()
	ctx := context.Background()
	rows, err := pg.Pool.Query(ctx, `SELECT video_id, neighbor_id, co_viewers, score, refreshed_at FROM analytics.video_coview ORDER BY video_id, neighbor_id`)
	if err != nil {
		t.Fatal(err)
	}
	i := 0
	for rows.Next() {
		var p reco.Pair
		var ts time.Time
		if err := rows.Scan(&p.VideoID, &p.NeighborID, &p.CoViewers, &p.Score, &ts); err != nil {
			t.Fatal(err)
		}
		if i >= len(pairs) || p.VideoID != pairs[i].VideoID || p.NeighborID != pairs[i].NeighborID || p.CoViewers != pairs[i].CoViewers || math.Abs(p.Score-pairs[i].Score) > 1e-6 || !ts.Equal(refreshed) {
			t.Fatalf("persisted pair: %+v at %v", p, ts)
		}
		i++
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	rows.Close()
	if i != len(pairs) {
		t.Fatalf("pairs count %d want %d", i, len(pairs))
	}
	rows, err = pg.Pool.Query(ctx, `SELECT viewer_key, video_id, last_watched_at, watched_ms, refreshed_at FROM analytics.viewer_history ORDER BY viewer_key, last_watched_at DESC, video_id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	i = 0
	for rows.Next() {
		var w reco.Watch
		var ts time.Time
		if err := rows.Scan(&w.ViewerKey, &w.VideoID, &w.LastWatchedAt, &w.WatchedMs, &ts); err != nil {
			t.Fatal(err)
		}
		if i >= len(history) || (w.ViewerKey != history[i].ViewerKey || w.VideoID != history[i].VideoID || w.WatchedMs != history[i].WatchedMs || !w.LastWatchedAt.Equal(history[i].LastWatchedAt)) || !ts.Equal(refreshed) {
			t.Fatalf("persisted watch %+v at %v", w, ts)
		}
		i++
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if i != len(history) {
		t.Fatalf("history count %d want %d", i, len(history))
	}
}
