package integration

import (
	"context"
	"reflect"
	"testing"
	"time"
)

// Task AV1-tel (ADR-048): codec and av1_capable go through the real worker into winkey.playback_events, stay NULL for
// older clients, and the share queries documented in db/clickhouse/0003_codec.sql give the expected numbers.
func TestCodecFieldsReachClickHouse(t *testing.T) {
	s := startStack(t)
	s.migrate()
	str := func(v string) *string { return &v }
	yes, no := true, false
	samples := generate(4, 300, 40000)
	now := time.Now().UTC().Truncate(time.Millisecond)
	fixture := []struct {
		codec   *string
		capable *bool
		watched int
	}{
		{str("av1"), &yes, 30000},
		{str("h264"), &yes, 10000},
		{str("h264"), &no, 20000},
		{nil, nil, 40000}, // an older client
	}
	for i, f := range fixture {
		samples[i].kind, samples[i].received, samples[i].watched = "start", now, f.watched
		samples[i].codec, samples[i].av1Capable = f.codec, f.capable
	}
	s.publish(samples)
	s.startWorker()
	waitFor(t, 30*time.Second, "codec samples persisted", func() bool { return s.count() == 4 })
	s.stopWorker()

	ctx := context.Background()
	for i, f := range fixture {
		var codec *string
		var capable *bool
		if err := s.conn.QueryRow(ctx, `SELECT codec, av1_capable FROM winkey.playback_events WHERE event_id=?`, samples[i].id).Scan(&codec, &capable); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(codec, f.codec) || !reflect.DeepEqual(capable, f.capable) {
			t.Fatalf("sample %d: codec=%v av1_capable=%v", i, codec, capable)
		}
	}
	var capableShare, watchShare float64
	if err := s.conn.QueryRow(ctx, `SELECT countIf(av1_capable) / countIf(av1_capable IS NOT NULL)
 FROM winkey.playback_events FINAL WHERE kind = 'start' AND received_at >= now() - INTERVAL 7 DAY`).Scan(&capableShare); err != nil {
		t.Fatal(err)
	}
	if err := s.conn.QueryRow(ctx, `SELECT sumIf(watched_ms, codec = 'av1') / sumIf(watched_ms, codec IS NOT NULL)
 FROM winkey.playback_events FINAL WHERE received_at >= now() - INTERVAL 7 DAY`).Scan(&watchShare); err != nil {
		t.Fatal(err)
	}
	if capableShare < 0.666 || capableShare > 0.667 || watchShare != 0.5 {
		t.Fatalf("shares differ: av1_capable=%v av1_watch=%v", capableShare, watchShare)
	}
}
