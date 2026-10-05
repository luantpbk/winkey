package job_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/luantpbk/winkey/services/transcoder/internal/job"
	"github.com/luantpbk/winkey/services/transcoder/internal/media"
	"github.com/luantpbk/winkey/services/transcoder/internal/testutil"
)

func stepNames(steps []job.StepTiming) []string {
	var out []string
	for _, s := range steps {
		out = append(out, s.Step)
	}
	return out
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// A real run records every timed step exactly once and in pipeline order, JobWall covers them, and the job
// leaves one summary line with each stage in seconds.
func TestProcessRecordsEveryStepOnceAndLogsOneSummary(t *testing.T) {
	f, _ := newFlow(t, media.EncoderX264, testutil.ClipSmall)
	f.Pipeline.Cfg.ArchiveDir = t.TempDir() // the archive step only runs when an archive is configured
	var logs bytes.Buffer
	f.Pipeline.Log = slog.New(slog.NewJSONHandler(&logs, nil))

	res := f.Pipeline.Process(context.Background(), f.Event(), job.Delivery{Num: 1, Max: 3})
	if res.Action != job.ActionAck || res.Stats == nil {
		t.Fatalf("result: %+v", res)
	}
	if got := stepNames(res.Steps); !equal(got, job.Steps) {
		t.Fatalf("steps = %v, want %v", got, job.Steps)
	}
	var sum time.Duration
	for _, s := range res.Steps {
		if s.Err {
			t.Errorf("step %s failed", s.Step)
		}
		// The in-memory store commits faster than the clock ticks on some platforms: only commit may be 0.
		if s.Dur < 0 || (s.Dur == 0 && s.Step != job.StepCommit) {
			t.Errorf("step %s took %v", s.Step, s.Dur)
		}
		sum += s.Dur
	}
	if res.Stats.JobWall < sum || res.Stats.JobWall > res.Stats.TotalWall {
		t.Errorf("JobWall %v must cover the steps (%v) and not exceed TotalWall %v", res.Stats.JobWall, sum, res.Stats.TotalWall)
	}

	// Exactly one summary line, with the documented fields and no user data.
	var summaries []map[string]any
	for _, line := range bytes.Split(bytes.TrimSpace(logs.Bytes()), []byte("\n")) {
		var m map[string]any
		if err := json.Unmarshal(line, &m); err != nil {
			t.Fatalf("log line is not JSON: %q", line)
		}
		if m["msg"] == "transcode succeeded" {
			summaries = append(summaries, m)
		}
	}
	if len(summaries) != 1 {
		t.Fatalf("%d summary lines, want 1", len(summaries))
	}
	m := summaries[0]
	for _, k := range []string{"video_id", "attempt", "encoder", "media_sec", "renditions", "upload_bytes", "job_seconds", "stage_seconds"} {
		if _, ok := m[k]; !ok {
			t.Errorf("summary lacks %q: %v", k, m)
		}
	}
	stages, _ := m["stage_seconds"].(map[string]any)
	for _, s := range job.Steps {
		if v, ok := stages[s].(float64); !ok || v < 0 || (v == 0 && s != job.StepCommit) {
			t.Errorf("stage_seconds.%s = %v", s, stages[s])
		}
	}
	if int64(m["upload_bytes"].(float64)) != res.Stats.UploadBytes || m["upload_bytes"].(float64) <= 0 {
		t.Errorf("upload_bytes %v vs stats %d", m["upload_bytes"], res.Stats.UploadBytes)
	}
	for _, banned := range []string{"title", "email", "filename", "owner_id"} {
		if _, ok := m[banned]; ok {
			t.Errorf("summary contains %q", banned)
		}
	}
}

// Without an archive the archive step does not run and is not recorded.
func TestProcessWithoutArchiveSkipsThatStep(t *testing.T) {
	f, _ := newFlow(t, media.EncoderX264, testutil.ClipSmall)
	res := f.Pipeline.Process(context.Background(), f.Event(), job.Delivery{Num: 1, Max: 3})
	want := []string{job.StepDownload, job.StepProbe, job.StepEncode, job.StepPoster, job.StepStoryboard, job.StepUpload, job.StepCommit}
	if got := stepNames(res.Steps); !equal(got, want) {
		t.Fatalf("steps = %v, want %v", got, want)
	}
}

// A failed job reports the steps that ran, the failing one marked as an error, and no JobWall.
func TestFailedJobsReportTheStepsThatRan(t *testing.T) {
	t.Run("download fails", func(t *testing.T) {
		f, _ := newFlow(t, media.EncoderX264, testutil.ClipSmall)
		f.Objs.DownloadErr = errors.New("s3 down")
		res := f.Pipeline.Process(context.Background(), f.Event(), job.Delivery{Num: 1, Max: 3})
		if len(res.Steps) != 1 || res.Steps[0].Step != job.StepDownload || !res.Steps[0].Err || res.Stats != nil {
			t.Fatalf("steps %+v stats %v", res.Steps, res.Stats)
		}
	})
	t.Run("probe rejects the file", func(t *testing.T) {
		tools := testutil.ToolsFromEnv(t)
		junk := filepath.Join(t.TempDir(), "junk")
		_ = os.WriteFile(junk, []byte("definitely not a video"), 0o644)
		f := testutil.NewFlow(t, tools, media.EncoderX264, junk)
		res := f.Pipeline.Process(context.Background(), f.Event(), job.Delivery{Num: 1, Max: 3})
		if got := stepNames(res.Steps); !equal(got, []string{job.StepDownload, job.StepProbe}) || res.Steps[0].Err || !res.Steps[1].Err {
			t.Fatalf("steps %+v", res.Steps)
		}
	})
	t.Run("nothing to do", func(t *testing.T) {
		f, _ := newFlow(t, media.EncoderX264, testutil.ClipSmall)
		f.Store.Video.Status = "READY"
		if res := f.Pipeline.Process(context.Background(), f.Event(), job.Delivery{Num: 1, Max: 3}); len(res.Steps) != 0 {
			t.Fatalf("steps %+v for a job that never started", res.Steps)
		}
	})
}

// A video deleted while it was processed is not READY: all steps were timed, but there is no JobWall.
func TestDiscardedJobHasNoJobWall(t *testing.T) {
	f, _ := newFlow(t, media.EncoderX264, testutil.ClipSmall)
	no := false
	f.Store.CompleteOK = &no
	res := f.Pipeline.Process(context.Background(), f.Event(), job.Delivery{Num: 1, Max: 3})
	if res.Stats == nil || res.Stats.JobWall != 0 || len(res.Steps) == 0 || res.Steps[len(res.Steps)-1].Step != job.StepCommit {
		t.Fatalf("%+v %+v", res.Stats, res.Steps)
	}
}
