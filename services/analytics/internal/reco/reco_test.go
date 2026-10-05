package reco

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

type sourceStub struct {
	err    error
	reads  int
	capped uint64
}

func (s *sourceStub) Read(context.Context, time.Time, Options) ([]Pair, []Watch, uint64, error) {
	s.reads++
	return nil, nil, s.capped, s.err
}

type sinkStub struct {
	err    error
	writes int
	at     time.Time
}

func (s *sinkStub) Replace(_ context.Context, _ []Pair, _ []Watch, at time.Time) error {
	s.writes++
	s.at = at
	return s.err
}

func TestRunnerFailurePreservesSuccessAndNeverLogsViewerKey(t *testing.T) {
	var log bytes.Buffer
	src, sink := &sourceStub{}, &sinkStub{}
	now := time.Now().UTC()
	r := &Runner{Source: src, Sink: sink, Log: slog.New(slog.NewJSONHandler(&log, nil)), Now: func() time.Time { return now }}
	if !r.RunOnce(context.Background()) || sink.at != now {
		t.Fatal("successful run failed")
	}
	stamp := testutil.ToFloat64(lastSuccess)
	src.capped = 7
	src.err = errors.New("private viewer_key sentinel")
	if r.RunOnce(context.Background()) || sink.writes != 1 {
		t.Fatal("failed read reached sink")
	}
	src.err = nil
	sink.err = errors.New("private viewer_key sentinel")
	if r.RunOnce(context.Background()) {
		t.Fatal("failed write succeeded")
	}
	if testutil.ToFloat64(lastSuccess) != stamp {
		t.Fatal("failure advanced success timestamp")
	}
	if testutil.ToFloat64(viewersCapped) != 0 {
		t.Fatal("failed run published a new capped-viewer count")
	}
	if strings.Contains(log.String(), "sentinel") {
		t.Fatal("private driver contents leaked")
	}
	sink.err = nil
	if !r.RunOnce(context.Background()) {
		t.Fatal("did not recover")
	}
	if testutil.ToFloat64(viewersCapped) != 7 {
		t.Fatal("successful run did not publish its capped-viewer count")
	}
	src.capped = 0
	if !r.RunOnce(context.Background()) || testutil.ToFloat64(viewersCapped) != 0 {
		t.Fatal("last-run gauge accumulated instead of resetting to zero")
	}
}
