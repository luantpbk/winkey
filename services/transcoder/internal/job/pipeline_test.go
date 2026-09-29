package job_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/luantpbk/winkey/services/transcoder/internal/job"
	"github.com/luantpbk/winkey/services/transcoder/internal/media"
	"github.com/luantpbk/winkey/services/transcoder/internal/testutil"
)

func newFlow(t *testing.T, encoder string, c testutil.Clip) (*testutil.Flow, job.Tools) {
	t.Helper()
	tools := testutil.ToolsFromEnv(t)
	clip := testutil.MakeClip(t, tools, t.TempDir(), c)
	return testutil.NewFlow(t, tools, encoder, clip), tools
}

func TestProcessHappyPath(t *testing.T) {
	f, _ := newFlow(t, media.EncoderX264, testutil.ClipSilent)
	res := f.Pipeline.Process(context.Background(), f.Event(), job.Delivery{Num: 1, Max: 3})
	if res.Action != job.ActionAck || res.Stats == nil {
		t.Fatalf("result: %+v", res)
	}
	if len(f.Store.Ready) != 1 || len(f.Store.Fails) != 0 {
		t.Fatalf("ready=%d fails=%d", len(f.Store.Ready), len(f.Store.Fails))
	}
	r := f.Store.Ready[0]
	prefix := fmt.Sprintf("v/%s/a1/", f.Video.ID)
	if r.Attempt != 1 || r.Encoder != "x264" || r.MasterKey != prefix+"hls/master.m3u8" ||
		r.ThumbKey != prefix+"thumb/poster.jpg" || len(r.Renditions) != 3 || r.Width != 1920 || r.Height != 1080 ||
		r.DurationMs < 11000 || r.DurationMs > 13000 {
		t.Fatalf("ready result: %+v", r)
	}
	if r.PlaylistKeys[1] != prefix+"hls/720p/index.m3u8" {
		t.Fatalf("playlist keys: %v", r.PlaylistKeys)
	}

	// Object layout, content types and cache headers.
	keys := f.Objs.Keys(testutil.MediaBucket)
	for _, want := range []string{"hls/master.m3u8", "hls/1080p/index.m3u8", "hls/480p/index.m3u8", "thumb/poster.jpg"} {
		if _, ok := f.Objs.Get(testutil.MediaBucket, prefix+want); !ok {
			t.Errorf("missing %s (have %v)", want, keys)
		}
	}
	types := map[string]bool{}
	for _, k := range keys {
		o, _ := f.Objs.Get(testutil.MediaBucket, k)
		if o.CacheControl != "public, max-age=31536000, immutable" {
			t.Errorf("%s: cache-control %q", k, o.CacheControl)
		}
		want := map[string]string{".m3u8": "application/vnd.apple.mpegurl", ".m4s": "video/mp4", ".mp4": "video/mp4", ".jpg": "image/jpeg"}[filepath.Ext(k)]
		if o.ContentType != want {
			t.Errorf("%s: content-type %q, want %q", k, o.ContentType, want)
		}
		types[o.ContentType] = true
	}
	if len(types) != 3 {
		t.Errorf("content types seen: %v", types)
	}
	if last := f.Objs.UploadOrder[len(f.Objs.UploadOrder)-1]; last != prefix+"hls/master.m3u8" {
		t.Errorf("master must be uploaded last, last was %s", last)
	}

	// What was published is playable: verify layout and let ffprobe read every variant.
	pub := testutil.MaterializeHLS(t, f.Objs, testutil.MediaBucket, prefix)
	if err := media.VerifyOutput(pub, r.Renditions); err != nil {
		t.Fatalf("published output: %v", err)
	}
	tools := testutil.ToolsFromEnv(t)
	for _, rd := range r.Renditions {
		vi, err := tools.Probe(context.Background(), filepath.Join(pub, rd.Name, "index.m3u8"))
		if err != nil || vi.DisplayW != rd.Width || vi.DisplayH != rd.Height || !vi.HasAudio {
			t.Errorf("%s: %+v %v", rd.Name, vi, err)
		}
	}

	// Progress: throttled events on core NATS, envelope + stage + monotonic.
	msgs := f.Events.Snapshot()
	if len(msgs) == 0 {
		t.Fatal("no progress events")
	}
	stages := map[string]bool{}
	prev := -1.0
	for _, m := range msgs {
		if m.Subject != "rt.video."+f.Video.ID.String()+".progress" {
			t.Fatalf("subject %s", m.Subject)
		}
		var env struct {
			Type string `json:"type"`
			Data struct {
				VideoID string  `json:"video_id"`
				Stage   string  `json:"stage"`
				Percent float64 `json:"percent"`
			} `json:"data"`
		}
		if err := json.Unmarshal(m.Data, &env); err != nil || env.Type != "video.progress" || env.Data.VideoID != f.Video.ID.String() {
			t.Fatalf("bad progress message: %v %s", err, m.Data)
		}
		if env.Data.Percent < prev {
			t.Errorf("progress went backwards: %v after %v", env.Data.Percent, prev)
		}
		prev = env.Data.Percent
		stages[env.Data.Stage] = true
	}
	if prev != 100 {
		t.Errorf("last progress %v, want 100", prev)
	}
	if !stages["TRANSCODING"] {
		t.Errorf("stages: %v", stages)
	}

	// Scratch is cleaned up.
	if entries, _ := os.ReadDir(f.Scratch); len(entries) != 0 {
		t.Errorf("scratch not cleaned: %v", entries)
	}
	if res.Stats.XRealtime() <= 0 {
		t.Error("stats missing")
	}
}

func TestProcessArchivesRawCopy(t *testing.T) {
	f, _ := newFlow(t, media.EncoderX264, testutil.ClipSmall)
	f.Pipeline.Cfg.ArchiveDir = t.TempDir()
	if res := f.Pipeline.Process(context.Background(), f.Event(), job.Delivery{Num: 1, Max: 3}); res.Action != job.ActionAck {
		t.Fatalf("%+v", res)
	}
	p := filepath.Join(f.Pipeline.Cfg.ArchiveDir, f.Video.OwnerID.String(), f.Video.ID.String(), "source")
	raw, _ := f.Objs.Get(testutil.RawBucket, f.Video.RawKey)
	got, err := os.ReadFile(p)
	if err != nil || len(got) != len(raw.Data) {
		t.Fatalf("archive: %v (%d vs %d bytes)", err, len(got), len(raw.Data))
	}
}

func TestProcessSkipsReady(t *testing.T) {
	f, _ := newFlow(t, media.EncoderX264, testutil.ClipSmall)
	f.Store.Video.Status = "READY"
	res := f.Pipeline.Process(context.Background(), f.Event(), job.Delivery{Num: 1, Max: 3})
	if res.Action != job.ActionAck || len(f.Objs.UploadOrder) != 0 || len(f.Store.Ready) != 0 {
		t.Fatalf("%+v", res)
	}
	f.Store.Video.Status, f.Store.Missing = "UPLOADED", true
	if res := f.Pipeline.Process(context.Background(), f.Event(), job.Delivery{Num: 1, Max: 3}); res.Action != job.ActionAck {
		t.Fatalf("deleted video must be acked: %+v", res)
	}
}

func TestProcessInvalidInputIsTerminalWithoutDLQ(t *testing.T) {
	tools := testutil.ToolsFromEnv(t)
	junk := filepath.Join(t.TempDir(), "junk")
	_ = os.WriteFile(junk, []byte("definitely not a video"), 0o644)
	f := testutil.NewFlow(t, tools, media.EncoderX264, junk)

	res := f.Pipeline.Process(context.Background(), f.Event(), job.Delivery{Num: 1, Max: 3})
	if res.Action != job.ActionTerm {
		t.Fatalf("want Term (no DLQ) on first delivery, got %+v", res)
	}
	if len(f.Store.Fails) != 1 {
		t.Fatalf("fails: %+v", f.Store.Fails)
	}
	fr := f.Store.Fails[0]
	if !fr.Terminal || fr.Failure.Reason != job.ReasonInvalidInput || fr.Failure.Retryable || fr.Attempt != 1 {
		t.Fatalf("fail record: %+v", fr)
	}
	if len(f.Objs.Keys(testutil.MediaBucket)) != 0 {
		t.Error("nothing may be uploaded for invalid input")
	}
}

func TestProcessRetryableFailureLifecycle(t *testing.T) {
	tools := testutil.ToolsFromEnv(t)
	clip := testutil.MakeClip(t, tools, t.TempDir(), testutil.ClipSmall)
	f := testutil.NewFlow(t, tools, media.EncoderX264, clip)
	f.Objs.DownloadErr = errors.New("garage unreachable")

	// Delivery 1 and 2: Nak with 1m x delivery; job FAILED, video stays PROCESSING.
	for d := 1; d <= 2; d++ {
		res := f.Pipeline.Process(context.Background(), f.Event(), job.Delivery{Num: d, Max: 3})
		if res.Action != job.ActionNak || res.Delay != time.Duration(d)*time.Minute {
			t.Fatalf("delivery %d: %+v", d, res)
		}
		fr := f.Store.Fails[d-1]
		if fr.Terminal || fr.Failure.Reason != job.ReasonStorage || fr.Attempt != d {
			t.Fatalf("delivery %d record: %+v", d, fr)
		}
	}
	// Last delivery: terminal, Term + DLQ copy.
	res := f.Pipeline.Process(context.Background(), f.Event(), job.Delivery{Num: 3, Max: 3})
	if res.Action != job.ActionTermDLQ {
		t.Fatalf("last delivery: %+v", res)
	}
	if fr := f.Store.Fails[2]; !fr.Terminal || fr.Failure.Reason != job.ReasonStorage {
		t.Fatalf("last record: %+v", fr)
	}
	if len(f.Store.Ready) != 0 {
		t.Fatal("must not become READY")
	}
}

func TestProcessRemovesOlderAttempts(t *testing.T) {
	f, _ := newFlow(t, media.EncoderX264, testutil.ClipSmall)
	id := f.Video.ID
	for _, k := range []string{"a1/hls/master.m3u8", "a1/thumb/poster.jpg", "a2/hls/master.m3u8", "a10/hls/master.m3u8", "other/x"} {
		f.Objs.Put(testutil.MediaBucket, fmt.Sprintf("v/%s/%s", id, k), []byte("old"))
	}
	f.Store.Attempts = 2 // this run is attempt 3
	if res := f.Pipeline.Process(context.Background(), f.Event(), job.Delivery{Num: 1, Max: 3}); res.Action != job.ActionAck {
		t.Fatalf("%+v", res)
	}
	for _, k := range f.Objs.Keys(testutil.MediaBucket) {
		if strings.Contains(k, "/a1/") || strings.Contains(k, "/a2/") {
			t.Errorf("old attempt survived: %s", k)
		}
	}
	// a10 is newer than a3 numerically and "other" is not an attempt: both stay.
	for _, k := range []string{"a10/hls/master.m3u8", "other/x", "a3/hls/master.m3u8"} {
		if _, ok := f.Objs.Get(testutil.MediaBucket, fmt.Sprintf("v/%s/%s", id, k)); !ok {
			t.Errorf("%s was deleted", k)
		}
	}
}

func TestProcessDiscardsOutputWhenVideoGone(t *testing.T) {
	f, _ := newFlow(t, media.EncoderX264, testutil.ClipSmall)
	no := false
	f.Store.CompleteOK = &no
	res := f.Pipeline.Process(context.Background(), f.Event(), job.Delivery{Num: 1, Max: 3})
	if res.Action != job.ActionAck {
		t.Fatalf("%+v", res)
	}
	if n := len(f.Objs.Keys(testutil.MediaBucket)); n != 0 {
		t.Fatalf("%d orphaned objects left", n)
	}
}

// With ENCODER=nvenc on a machine without a working NVENC, the attempt must
// fall back to x264 and record it.
func TestProcessNVENCFallsBackToX264(t *testing.T) {
	tools := testutil.ToolsFromEnv(t)
	if enc, _ := tools.ResolveEncoder(context.Background(), "auto"); enc == media.EncoderNVENC {
		t.Skip("this machine has working NVENC; fallback cannot be provoked")
	}
	clip := testutil.MakeClip(t, tools, t.TempDir(), testutil.ClipSmall)
	f := testutil.NewFlow(t, tools, media.EncoderNVENC, clip)
	res := f.Pipeline.Process(context.Background(), f.Event(), job.Delivery{Num: 1, Max: 3})
	if res.Action != job.ActionAck || len(f.Store.Ready) != 1 {
		t.Fatalf("%+v", res)
	}
	if f.Store.Ready[0].Encoder != "x264" || len(f.Store.Encoders) != 1 || f.Store.Encoders[0] != "x264" {
		t.Fatalf("encoder not recorded as x264: ready=%q calls=%v", f.Store.Ready[0].Encoder, f.Store.Encoders)
	}
	if f.Store.Begun[0] != "nvenc" {
		t.Errorf("job started as %q", f.Store.Begun[0])
	}
}

func TestProcessInterruptedNaksWithoutBlamingVideo(t *testing.T) {
	f, _ := newFlow(t, media.EncoderX264, testutil.ClipLandscape)
	f.Pipeline.Cfg.X264Preset = "slow" // make sure it is still encoding when cancelled
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(1500 * time.Millisecond); cancel() }()

	res := f.Pipeline.Process(ctx, f.Event(), job.Delivery{Num: 1, Max: 3})
	if res.Action != job.ActionNak || !errors.Is(res.Err, job.ErrInterrupted) {
		t.Fatalf("%+v", res)
	}
	if len(f.Store.Fails) != 1 || f.Store.Fails[0].Terminal {
		t.Fatalf("interrupted job must be recorded non-terminal: %+v", f.Store.Fails)
	}
	if len(f.Objs.Keys(testutil.MediaBucket)) != 0 {
		t.Error("no output may be published when interrupted")
	}
	if entries, _ := os.ReadDir(f.Scratch); len(entries) != 0 {
		t.Errorf("scratch not cleaned: %v", entries)
	}
}

func TestEncodeTimeout(t *testing.T) {
	for _, tc := range []struct {
		dur  float64
		want time.Duration
	}{{10, 10 * time.Minute}, {200, 10 * time.Minute}, {300, 15 * time.Minute}, {3600, 3 * time.Hour}} {
		if got := job.EncodeTimeout(tc.dur); got != tc.want {
			t.Errorf("EncodeTimeout(%v) = %v, want %v", tc.dur, got, tc.want)
		}
	}
}

func TestDelivery(t *testing.T) {
	if (job.Delivery{Num: 2, Max: 3}).Last() || !(job.Delivery{Num: 3, Max: 3}).Last() || (job.Delivery{Num: 9}).Last() {
		t.Fatal("Last()")
	}
}

// TestX264Speed reports how fast the x264 fallback runs a 30 s 1080p30 clip
// through the whole pipeline on this machine (informational; -v to see it).
func TestX264Speed(t *testing.T) {
	f, _ := newFlow(t, media.EncoderX264, testutil.ClipLandscape)
	res := f.Pipeline.Process(context.Background(), f.Event(), job.Delivery{Num: 1, Max: 3})
	if res.Stats == nil {
		t.Fatalf("%+v", res)
	}
	t.Logf("x264 %s: %d logical CPUs, %.0f s of 1080p30 -> encode %.1f s (x%.1f realtime), total %.1f s, %d MiB uploaded",
		f.Pipeline.Cfg.X264Preset, runtime.NumCPU(), res.Stats.MediaSec, res.Stats.EncodeWall.Seconds(),
		res.Stats.XRealtime(), res.Stats.TotalWall.Seconds(), res.Stats.UploadBytes>>20)
}
