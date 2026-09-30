package job

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
)

func TestBuildStoryboardRetriesOnTheCPUWhenTheGPUDecoderFails(t *testing.T) {
	var hws []bool
	p := &Pipeline{Storyboard: func(_ context.Context, _, _ string, _ float64, hw bool) (StoryboardResult, error) {
		hws = append(hws, hw)
		if hw {
			return StoryboardResult{}, errors.New("cuda decoder unavailable")
		}
		return StoryboardResult{Frames: 6, Sheets: 1}, nil
	}}
	key, _, err := p.buildStoryboard(context.Background(), "src", t.TempDir(), "v/x/a1/", 12, true, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err != nil || key != "v/x/a1/storyboard/storyboard.vtt" || len(hws) != 2 || !hws[0] || hws[1] {
		t.Fatalf("key=%q err=%v calls=%v", key, err, hws)
	}
}

func TestBuildStoryboardOnTheCPUFailsOnce(t *testing.T) {
	calls := 0
	var logs strings.Builder
	p := &Pipeline{Storyboard: func(context.Context, string, string, float64, bool) (StoryboardResult, error) {
		calls++
		return StoryboardResult{}, errors.New("boom")
	}}
	key, _, err := p.buildStoryboard(context.Background(), "src", t.TempDir(), "v/x/a1/", 12, false, slog.New(slog.NewJSONHandler(&logs, nil)))
	if err != nil || key != "" || calls != 1 || !strings.Contains(logs.String(), "continuing without it") {
		t.Fatalf("key=%q err=%v calls=%d logs=%s", key, err, calls, logs.String())
	}
}
