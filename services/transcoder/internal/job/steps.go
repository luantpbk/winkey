package job

import (
	"log/slog"
	"sync"
	"time"
)

// Steps of one job that are timed (task V4-a, ADR-031). The values are the `stage` label of
// transcoder_stage_seconds and the keys of the `stage_seconds` object in the job's summary log line.
const (
	StepDownload   = "download"
	StepArchive    = "archive"
	StepProbe      = "probe"
	StepEncode     = "encode"
	StepPoster     = "poster"
	StepStoryboard = "storyboard"
	StepUpload     = "upload"
	StepCommit     = "commit"
)

// Steps lists the timed steps in pipeline order.
var Steps = []string{StepDownload, StepArchive, StepProbe, StepEncode, StepPoster, StepStoryboard, StepUpload, StepCommit}

// StepTiming is how long one step took and whether it succeeded. Only steps that ran are recorded.
type StepTiming struct {
	Step string
	Dur  time.Duration
	Err  bool // the step failed (the job stopped there, except the best-effort storyboard)
}

// timings collects the StepTimings of one run; it is safe for concurrent use (V4-b runs steps in parallel).
type timings struct {
	mu    sync.Mutex
	steps []StepTiming
}

// time runs fn and records its duration under step. The step counts as failed when fn returns an error.
func (t *timings) time(step string, fn func() error) error {
	start := time.Now()
	err := fn()
	t.add(step, time.Since(start), err != nil)
	return err
}

func (t *timings) add(step string, d time.Duration, failed bool) {
	t.mu.Lock()
	t.steps = append(t.steps, StepTiming{Step: step, Dur: d, Err: failed})
	t.mu.Unlock()
}

// snapshot returns the recorded steps in the order they finished.
func (t *timings) snapshot() []StepTiming {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]StepTiming(nil), t.steps...)
}

// stageSeconds is the `stage_seconds` object of the summary log line: seconds per step, to the millisecond.
func stageSeconds(steps []StepTiming) slog.Attr {
	args := make([]any, 0, len(steps))
	for _, s := range steps {
		args = append(args, slog.Float64(s.Step, float64(s.Dur.Round(time.Millisecond))/float64(time.Second)))
	}
	return slog.Group("stage_seconds", args...)
}
