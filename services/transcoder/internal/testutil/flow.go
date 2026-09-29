package testutil

import (
	"io"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/services/transcoder/internal/job"
)

const (
	RawBucket   = "winkey-raw"
	MediaBucket = "winkey-media"
)

// Flow is a complete in-memory pipeline around one raw video: fake store,
// object storage and events, with real ffmpeg.
type Flow struct {
	Store    *MemStore
	Objs     *MemObjects
	Events   *RecEvents
	Pipeline *job.Pipeline
	Video    job.Video
	Scratch  string
}

// NewFlow stores the file at clipPath as the raw object of a fresh UPLOADED
// video and builds a pipeline using the given encoder ("nvenc" or "x264").
func NewFlow(t testing.TB, tools job.Tools, encoder, clipPath string) *Flow {
	t.Helper()
	data, err := os.ReadFile(clipPath)
	if err != nil {
		t.Fatal(err)
	}
	owner, vid := uuid.New(), uuid.New()
	v := job.Video{ID: vid, OwnerID: owner, Status: "UPLOADED", RawBucket: RawBucket,
		RawKey: owner.String() + "/" + vid.String() + "/source"}
	objs := NewMemObjects()
	objs.Put(RawBucket, v.RawKey, data)

	f := &Flow{Store: &MemStore{Video: v}, Objs: objs, Events: &RecEvents{}, Video: v, Scratch: t.TempDir()}
	f.Pipeline = &job.Pipeline{
		Store: f.Store, Objects: objs, Events: f.Events, Tools: tools,
		Log: slog.New(slog.NewJSONHandler(io.Discard, nil)),
		Cfg: job.Config{
			ScratchDir: f.Scratch, MediaBucket: MediaBucket, Encoder: encoder, X264Preset: "veryfast",
			UploadParallelism: 8, WorkerID: "test", ProgressInterval: 50 * time.Millisecond,
		},
	}
	return f
}

// Event is the video.uploaded payload for the flow's video.
func (f *Flow) Event() job.UploadedEvent {
	return job.UploadedEvent{
		VideoID: f.Video.ID.String(), OwnerID: f.Video.OwnerID.String(),
		RawBucket: f.Video.RawBucket, RawKey: f.Video.RawKey,
	}
}
