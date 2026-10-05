package worker

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/luantpbk/winkey/services/transcoder/internal/job"
)

// Stage metrics (task V4-a, ADR-031): where the time of a job goes.
var (
	// 0.1 s ... 1 h: a poster takes a fraction of a second, the encode of a long video most of an hour.
	timeBuckets = []float64{0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60, 120, 300, 600, 1200, 1800, 3600}

	stageSeconds = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name: "transcoder_stage_seconds", Buckets: timeBuckets,
		Help: "Duration of each step of a job (download, archive, probe, encode, poster, storyboard, upload, commit); result=error when the step failed.",
	}, []string{"stage", "result"})
	jobSeconds = promauto.NewHistogram(prometheus.HistogramOpts{
		Name: "transcoder_job_seconds", Buckets: timeBuckets,
		Help: "Time from the start of the download to the video being READY; successful jobs only.",
	})
	uploadBytes = promauto.NewCounter(prometheus.CounterOpts{
		Name: "transcoder_upload_bytes_total",
		Help: "Bytes of HLS output, poster and storyboard uploaded by jobs that made a video READY.",
	})
)

// observeResult records the stage metrics of one finished job: every step that ran (also when the job
// failed), and, for a job that made the video READY, its total time and uploaded bytes.
func observeResult(res job.Result) {
	for _, s := range res.Steps {
		result := "ok"
		if s.Err {
			result = "error"
		}
		stageSeconds.WithLabelValues(s.Step, result).Observe(s.Dur.Seconds())
	}
	if st := res.Stats; st != nil && st.JobWall > 0 {
		jobSeconds.Observe(st.JobWall.Seconds())
		uploadBytes.Add(float64(st.UploadBytes))
	}
}
