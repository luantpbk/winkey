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

func TestRecoCoviewCapBeforeJoin(t *testing.T) {
	for _, image := range []string{"clickhouse/clickhouse-server:25.8", "clickhouse/clickhouse-server:26.9.6.6"} {
		t.Run(image, func(t *testing.T) {
			t.Setenv("WINKEY_CLICKHOUSE_IMAGE", image)
			ch := testkit.StartClickHouse(t)
			conn, err := chdb.Open(chdb.Options{Addr: ch.Addr, User: "default"})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = conn.Close() })
			ctx := context.Background()
			if _, err := migrate.Apply(ctx, chdb.Migrations{Conn: conn}, migrationsDir(t), quiet()); err != nil {
				t.Fatal(err)
			}
			now := time.Now().UTC().Truncate(time.Second)
			video := func(i int) uuid.UUID { return uuid.MustParse(fmt.Sprintf("00000000-0000-4000-8000-%012x", i)) }
			var raw []event.Row
			add := func(viewer, index int, watch uint32, at time.Time) {
				id := uuid.NewSHA1(uuid.NameSpaceOID, []byte(fmt.Sprintf("cap-%d", len(raw))))
				raw = append(raw, event.Row{EventID: id, PlaybackID: id, VideoID: video(index), OwnerID: ownerA,
					ViewerKey: viewerKey(viewer), Authenticated: true, Kind: "heartbeat", Client: "web",
					WatchedMs: watch, ReceivedAt: at, SentAt: at})
			}
			// N=10, N+5 qualified videos. 4 and 5 tie at the cutoff: UUID ASC keeps 4.
			for i := 0; i < 15; i++ {
				if i == 4 {
					add(0, i, 10000, now.Add(-2*time.Hour))
					add(0, i, 10000, now.Add(-10*time.Minute))
				} else {
					add(0, i, 20000, now.Add(-time.Duration(15-i)*time.Minute))
				}
			}
			add(0, 200, 10000, now.Add(-time.Second)) // latest but not qualified, even after duplicate INSERT
			add(0, 201, 20000, now.AddDate(0, 0, -31))
			add(0, 202, 20000, now.Add(time.Minute))
			for viewer := 1; viewer <= 3; viewer++ {
				for _, i := range []int{0, 4, 14} {
					add(viewer, i, 20000, now.Add(-time.Minute))
				}
			}
			for viewer := 4; viewer <= 6; viewer++ {
				for _, i := range []int{100, 101} {
					add(viewer, i, 20000, now.Add(-time.Minute))
				}
			}
			add(7, 0, 20000, now.Add(-time.Minute))
			ins := &chdb.Inserter{Conn: conn}
			for _, token := range []string{"cap-initial", "cap-unmerged-duplicates"} {
				if err := ins.InsertBatch(ctx, raw, token); err != nil {
					t.Fatal(err)
				}
			}
			src := &reco.ClickHouse{Conn: conn}
			opts := reco.Options{WindowDays: 30, MinWatchMs: 20000, Neighbors: 30, History: 50, CoviewMax: 10}
			pairs, history, capped, err := src.Read(ctx, now, opts)
			if err != nil || capped != 1 {
				t.Fatalf("cap stats got %d want 1, err=%v", capped, err)
			}
			// Capped counts: viewers(0)=4, viewers(4)=viewers(14)=4; shared(0,4)=shared(0,14)=3.
			want := []reco.Pair{
				{VideoID: video(0), NeighborID: video(4), CoViewers: 3, Score: .75},
				{VideoID: video(0), NeighborID: video(14), CoViewers: 3, Score: .75},
				{VideoID: video(4), NeighborID: video(14), CoViewers: 4, Score: 1},
				{VideoID: video(4), NeighborID: video(0), CoViewers: 3, Score: .75},
				{VideoID: video(14), NeighborID: video(4), CoViewers: 4, Score: 1},
				{VideoID: video(14), NeighborID: video(0), CoViewers: 3, Score: .75},
				{VideoID: video(100), NeighborID: video(101), CoViewers: 3, Score: 1},
				{VideoID: video(101), NeighborID: video(100), CoViewers: 3, Score: 1},
			}
			if !reflect.DeepEqual(pairs, want) {
				t.Fatalf("exact capped pairs got %+v want %+v", pairs, want)
			}
			var heavyHistory []reco.Watch
			for _, w := range history {
				if w.ViewerKey == viewerKey(0) {
					heavyHistory = append(heavyHistory, w)
				}
			}
			if len(heavyHistory) != 15 || heavyHistory[9].VideoID != video(4) || heavyHistory[10].VideoID != video(5) || heavyHistory[9].WatchedMs != 20000 {
				t.Fatal("history was capped or max(received_at)/UUID tie/FINAL qualification changed")
			}
			opts.CoviewMax = 200
			uncapped, fullHistory, count, err := src.Read(ctx, now, opts)
			if err != nil || count != 0 || !reflect.DeepEqual(fullHistory, history) || len(uncapped) != len(pairs) {
				t.Fatal("raising co-view cap changed history or counted an uncapped viewer")
			}
			for i, p := range uncapped {
				if p.VideoID != want[i].VideoID || p.NeighborID != want[i].NeighborID {
					t.Fatal("unbounded pair order differs")
				}
				if p.VideoID == video(0) || p.NeighborID == video(0) {
					if p.CoViewers != 4 || math.Abs(p.Score-4/math.Sqrt(20)) > 1e-12 {
						t.Fatal("uncapped denominator fixture differs")
					}
				} else if p != want[i] {
					t.Fatal("pairs among other viewers changed")
				}
			}
			t.Log("N=10/N+5=15: exact eight directed pairs; capped denominators; UUID cutoff tie; history unchanged; capped viewers 1 then 0")
			// Make every retained/dropped video observable through an anchor pair. Each support viewer has only two
			// videos, so only the N+5 viewer is truncated; co-view also includes anonymous viewers.
			if err := conn.Exec(ctx, `TRUNCATE TABLE winkey.playback_events`); err != nil {
				t.Fatal(err)
			}
			raw = nil
			for i := 0; i < 15; i++ {
				add(0, i, 20000, now.Add(-time.Duration(15-i)*time.Minute))
			}
			for i := 0; i < 14; i++ {
				for k := 0; k < 2; k++ {
					viewer := 10 + i*2 + k
					add(viewer, i, 20000, now.Add(-time.Minute))
					add(viewer, 14, 20000, now.Add(-time.Minute))
				}
			}
			for i := range raw {
				raw[i].Authenticated = false
			}
			if err := ins.InsertBatch(ctx, raw, "cap-all-membership"); err != nil {
				t.Fatal(err)
			}
			opts.CoviewMax = 10
			pairs, history, capped, err = src.Read(ctx, now, opts)
			if err != nil || capped != 1 || len(history) != 0 {
				t.Fatal("anonymous co-view qualification changed")
			}
			want = nil
			for i := 5; i < 14; i++ {
				want = append(want, reco.Pair{VideoID: video(i), NeighborID: video(14), CoViewers: 3, Score: 3 / math.Sqrt(87)})
			}
			for i := 5; i < 14; i++ {
				want = append(want, reco.Pair{VideoID: video(14), NeighborID: video(i), CoViewers: 3, Score: 3 / math.Sqrt(87)})
			}
			if len(pairs) != len(want) {
				t.Fatalf("all-membership pair count %d want %d", len(pairs), len(want))
			}
			for i, p := range pairs {
				if p.VideoID != want[i].VideoID || p.NeighborID != want[i].NeighborID || p.CoViewers != want[i].CoViewers || math.Abs(p.Score-want[i].Score) > 1e-12 {
					t.Fatal("cap did not retain exactly videos 5..14 before joining")
				}
			}
			t.Log("All ten retained videos verified: exactly 18 anchor edges; all five older videos excluded; anonymous viewers included")
		})
	}
}
