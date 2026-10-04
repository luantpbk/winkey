package integration

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/luantpbk/winkey/services/analytics/internal/chdb"
	"github.com/luantpbk/winkey/services/analytics/internal/event"
)

type abDay struct {
	day, arm, surface                 string
	samples, starts, watched, viewers uint64
}

func readABDays(t *testing.T, s *stack) []abDay {
	t.Helper()
	rows, err := s.conn.Query(context.Background(), `SELECT toString(day), reco_variant, surface,
 sum(samples), sum(starts), sum(watched_ms), uniqMerge(viewers)
 FROM winkey.reco_ab_daily GROUP BY day, reco_variant, surface ORDER BY day, reco_variant, surface`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	var out []abDay
	for rows.Next() {
		var row abDay
		if err := rows.Scan(&row.day, &row.arm, &row.surface, &row.samples, &row.starts, &row.watched, &row.viewers); err != nil {
			t.Fatal(err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestRecoABDailyMaterializationAndReplay(t *testing.T) {
	for _, image := range []string{"clickhouse/clickhouse-server:26.9.6.6", "clickhouse/clickhouse-server:25.8"} {
		t.Run(image, func(t *testing.T) {
			t.Setenv("WINKEY_CLICKHOUSE_IMAGE", image)
			s := startStack(t)
			s.migrate()
			if got := s.migrate(); len(got) != 0 {
				t.Fatal("second migration run was not a no-op")
			}
			ctx := context.Background()
			ptr := func(v string) *string { return &v }
			day1 := time.Date(2026, 10, 2, 16, 59, 0, 0, time.UTC) // 23:59 in Asia/Ho_Chi_Minh.
			day2 := day1.Add(2 * time.Minute)
			samples := generate(10, 100, 20000)
			fixture := []struct {
				auth         bool
				arm, surface *string
				viewer       int
				kind         string
				watched      int
				at           time.Time
			}{
				{true, ptr("reco"), ptr("for_you"), 0, "start", 1000, day1},
				{true, ptr("reco"), ptr("for_you"), 0, "heartbeat", 3000, day1},
				{true, ptr("reco"), ptr("search"), 0, "heartbeat", 2000, day1},
				{true, ptr("reco"), ptr("for_you"), 1, "heartbeat", 4000, day1},
				{true, ptr("control"), nil, 2, "start", 5000, day1},
				{true, ptr("control"), ptr("trending"), 2, "heartbeat", 6000, day1},
				{true, ptr("reco"), ptr("for_you"), 3, "start", 7000, day2},
				{true, nil, ptr("for_you"), 4, "heartbeat", 8888, day1},
				{false, ptr("reco"), ptr("for_you"), 5, "heartbeat", 9999, day1},
				{true, nil, nil, 6, "heartbeat", 1234, day1},
			}
			rows := make([]event.Row, len(samples))
			for i, f := range fixture {
				sm := &samples[i]
				sm.authenticated, sm.recoVariant, sm.surface = f.auth, f.arm, f.surface
				sm.viewer, sm.kind, sm.watched, sm.received = viewerKey(f.viewer), f.kind, f.watched, f.at
				row, result := event.Decode(sm.payload())
				if result != event.OK {
					t.Fatal("fixture did not decode")
				}
				rows[i] = row
			}
			writer := &chdb.Inserter{Conn: s.conn}
			want := []abDay{
				{"2026-10-02", "control", "trending", 1, 0, 6000, 1},
				{"2026-10-02", "control", "unknown", 1, 1, 5000, 1},
				{"2026-10-02", "reco", "for_you", 3, 1, 8000, 2},
				{"2026-10-02", "reco", "search", 1, 0, 2000, 1},
				{"2026-10-03", "reco", "for_you", 1, 1, 7000, 1},
			}
			assert := func(want []abDay, raw uint64) {
				t.Helper()
				if s.count() != raw {
					t.Fatalf("raw count differs: got %d want %d", s.count(), raw)
				}
				if got := readABDays(t, s); !reflect.DeepEqual(got, want) {
					t.Fatalf("daily totals got %#v want %#v", got, want)
				}
			}
			for attempt := 0; attempt < 2; attempt++ {
				if err := writer.InsertBatch(ctx, rows, "r2ab-initial"); err != nil {
					t.Fatal(err)
				}
				assert(want, 10)
			}
			// Nullable columns round-trip exactly; absent fields in legacy samples remain NULL.
			for _, row := range rows {
				var surface, arm *string
				if err := s.conn.QueryRow(ctx, `SELECT surface,reco_variant FROM winkey.playback_events WHERE event_id=?`, row.EventID).Scan(&surface, &arm); err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(surface, row.Surface) || !reflect.DeepEqual(arm, row.RecoVariant) {
					t.Fatal("nullable fields differ after insertion")
				}
			}
			// uniqMerge across surfaces counts the same active viewer once, as the primary ADR-030 metric requires.
			var watch, viewers uint64
			if err := s.conn.QueryRow(ctx, `SELECT sum(watched_ms),uniqMerge(viewers) FROM winkey.reco_ab_daily WHERE day='2026-10-02' AND reco_variant='reco'`).Scan(&watch, &viewers); err != nil || watch != 10000 || viewers != 2 {
				t.Fatalf("cross-surface metric differs: watch=%d viewers=%d err=%v", watch, viewers, err)
			}
			// #193: a redelivered batch with different bounds inserts only its missing event, not its overlap.
			fresh := rows[0]
			fresh.EventID, fresh.PlaybackID, fresh.WatchedMs = uuid.New(), uuid.New(), 8000
			pending, err := writer.Unwritten(ctx, append(append([]event.Row{}, rows[:3]...), fresh))
			if err != nil || len(pending) != 1 || pending[0].EventID != fresh.EventID {
				t.Fatal("rebatched replay did not reconcile")
			}
			want[2].samples++
			want[2].starts++
			want[2].watched += 8000
			for attempt := 0; attempt < 2; attempt++ {
				if err := writer.InsertBatch(ctx, pending, "r2ab-rebatched"); err != nil {
					t.Fatal(err)
				}
				assert(want, 11)
			}
			// The real JetStream worker must retain both fields through decoding, INSERT and acknowledgement.
			throughWorker := generate(1, 200, 30000)[0]
			throughWorker.authenticated, throughWorker.recoVariant, throughWorker.surface = true, ptr("control"), ptr("playlist")
			throughWorker.viewer, throughWorker.kind, throughWorker.watched, throughWorker.received = viewerKey(2), "start", 9000, day1
			s.publish([]sample{throughWorker})
			s.startWorker()
			waitFor(t, 30*time.Second, "R2-ab sample persisted", func() bool { return s.count() == 12 })
			waitFor(t, 30*time.Second, "R2-ab sample acknowledged", func() bool { info := s.info(); return info.NumPending == 0 && info.NumAckPending == 0 })
			s.stopWorker()
			want = append([]abDay{{"2026-10-02", "control", "playlist", 1, 1, 9000, 1}}, want...)
			assert(want, 12)
		})
	}
}
