package job

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"testing"
	"time"
)

// A measured step never logs as 0 s; only a step that took no time at all does.
func TestStageSecondsNeverRoundsAMeasuredStepToZero(t *testing.T) {
	var buf bytes.Buffer
	slog.New(slog.NewJSONHandler(&buf, nil)).Info("x", stageSeconds([]StepTiming{
		{Step: "download", Dur: 300 * time.Microsecond},
		{Step: "probe", Dur: 1499 * time.Microsecond},
		{Step: "encode", Dur: 2500 * time.Millisecond},
		{Step: "commit", Dur: 0},
	}))
	var m struct {
		Stages map[string]float64 `json:"stage_seconds"`
	}
	if err := json.Unmarshal(buf.Bytes(), &m); err != nil {
		t.Fatal(err)
	}
	want := map[string]float64{"download": 0.001, "probe": 0.001, "encode": 2.5, "commit": 0}
	for k, v := range want {
		if m.Stages[k] != v {
			t.Errorf("%s = %v, want %v", k, m.Stages[k], v)
		}
	}
}
