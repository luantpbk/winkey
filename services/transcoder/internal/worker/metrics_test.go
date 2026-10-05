package worker

import (
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	dto "github.com/prometheus/client_model/go"

	"github.com/luantpbk/winkey/services/transcoder/internal/job"
)

func sampleCount(t *testing.T, o prometheus.Observer) uint64 {
	t.Helper()
	var m dto.Metric
	if err := o.(prometheus.Metric).Write(&m); err != nil {
		t.Fatal(err)
	}
	return m.GetHistogram().GetSampleCount()
}

func stageCount(t *testing.T, stage, result string) uint64 {
	t.Helper()
	o, err := stageSeconds.GetMetricWithLabelValues(stage, result)
	if err != nil {
		t.Fatal(err)
	}
	return sampleCount(t, o)
}

func jobSecondsCount(t *testing.T) uint64 { return sampleCount(t, jobSeconds) }

func TestObserveResultRecordsEveryStepAndTheJob(t *testing.T) {
	steps := []job.StepTiming{}
	for _, s := range job.Steps {
		steps = append(steps, job.StepTiming{Step: s, Dur: 1500 * time.Millisecond})
	}
	before := map[string]uint64{}
	for _, s := range job.Steps {
		before[s] = stageCount(t, s, "ok")
	}
	jobsBefore := jobSecondsCount(t)
	bytesBefore := testutil.ToFloat64(uploadBytes)

	observeResult(job.Result{Steps: steps, Stats: &job.Stats{JobWall: 42 * time.Second, UploadBytes: 1234}})

	for _, s := range job.Steps {
		if got := stageCount(t, s, "ok") - before[s]; got != 1 {
			t.Errorf("stage %s observed %d times, want 1", s, got)
		}
	}
	if got := testutil.ToFloat64(uploadBytes) - bytesBefore; got != 1234 {
		t.Errorf("upload bytes grew by %v, want 1234", got)
	}
	if got := jobSecondsCount(t) - jobsBefore; got != 1 {
		t.Errorf("job_seconds observed %d times, want 1", got)
	}
}

// A failed job records the steps that ran (the failing one with result=error) and no job time or bytes.
func TestObserveFailedResult(t *testing.T) {
	okBefore, errBefore := stageCount(t, job.StepEncode, "ok"), stageCount(t, job.StepEncode, "error")
	jobsBefore, bytesBefore := jobSecondsCount(t), testutil.ToFloat64(uploadBytes)

	observeResult(job.Result{Steps: []job.StepTiming{
		{Step: job.StepDownload, Dur: time.Second}, {Step: job.StepEncode, Dur: 3 * time.Second, Err: true},
	}})

	if stageCount(t, job.StepEncode, "error")-errBefore != 1 || stageCount(t, job.StepEncode, "ok") != okBefore {
		t.Error("the failed encode must be recorded once with result=error")
	}
	if jobSecondsCount(t) != jobsBefore || testutil.ToFloat64(uploadBytes) != bytesBefore {
		t.Error("a failed job must not observe job_seconds or upload bytes")
	}
	// A video discarded because it was deleted meanwhile is not READY: no job time either.
	observeResult(job.Result{Stats: &job.Stats{Encoder: "x264"}})
	if jobSecondsCount(t) != jobsBefore {
		t.Error("a discarded job observed job_seconds")
	}
}

// The metrics are registered exactly once in the default registry, under the documented names.
func TestMetricsAreRegisteredOnce(t *testing.T) {
	observeResult(job.Result{Steps: []job.StepTiming{{Step: job.StepProbe, Dur: time.Second}}, Stats: &job.Stats{JobWall: time.Second}})
	mfs, err := prometheus.DefaultGatherer.Gather()
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]int{}
	for _, mf := range mfs {
		seen[mf.GetName()]++
	}
	for _, name := range []string{"transcoder_stage_seconds", "transcoder_job_seconds", "transcoder_upload_bytes_total"} {
		if seen[name] != 1 {
			t.Errorf("%s registered %d times", name, seen[name])
		}
	}
}
