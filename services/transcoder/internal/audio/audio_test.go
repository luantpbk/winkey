package audio

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/hlsmaster"
	"github.com/luantpbk/winkey/services/transcoder/internal/testutil"
)

type fakeStore struct {
	outcome    Outcome
	track      Track
	beginErr   error
	completeOK bool
	master     string // the video's hls_master_key, rewritten by CompleteAudio
	ready      []hlsmaster.Track

	completed []string // playlist keys
	failures  []Failure
}

func (s *fakeStore) BeginAudio(context.Context, uuid.UUID) (Outcome, Track, error) {
	return s.outcome, s.track, s.beginErr
}

func (s *fakeStore) CompleteAudio(ctx context.Context, id uuid.UUID, playlistKey string, durationMs int, rewrite Rewrite) (bool, error) {
	if !s.completeOK {
		return false, nil
	}
	s.completed = append(s.completed, playlistKey)
	ready := append(s.ready, hlsmaster.Track{ID: id.String(), Lang: s.track.Lang, Label: "Thuyết minh", Kind: s.track.Kind, PlaylistKey: playlistKey})
	key, err := rewrite(ctx, s.master, ready)
	if err != nil {
		return false, err
	}
	s.master = key
	return true, nil
}

func (s *fakeStore) FailAudio(_ context.Context, _ uuid.UUID, f Failure) (bool, error) {
	s.failures = append(s.failures, f)
	return true, nil
}

const plainMaster = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-STREAM-INF:BANDWIDTH=1210000,RESOLUTION=640x360,CODECS=\"avc1.64001e,mp4a.40.2\"\n360p/index.m3u8\n"

type env struct {
	job   *Job
	store *fakeStore
	objs  *testutil.MemObjects
	track Track
	ev    UploadedEvent
}

func newEnv(t *testing.T, media Media) *env {
	t.Helper()
	vid, tid := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	tr := Track{ID: tid, VideoID: vid, OwnerID: uuid.Must(uuid.NewV7()), Lang: "vi", Kind: "voiceover",
		RawBucket: "winkey-raw", RawKey: "o/" + vid.String() + "/audio/" + tid.String() + "/source", VideoDurationMs: 8000}
	objs := testutil.NewMemObjects()
	master := "v/" + vid.String() + "/a1/hls/master.m3u8"
	objs.Put("winkey-media", master, []byte(plainMaster))
	st := &fakeStore{outcome: Run, track: tr, completeOK: true, master: master}
	return &env{
		job: &Job{Store: st, Objects: objs, Media: media, MediaBucket: "winkey-media", WorkDir: t.TempDir(),
			Log: slog.New(slog.NewJSONHandler(io.Discard, nil))},
		store: st, objs: objs, track: tr,
		ev: UploadedEvent{VideoID: vid.String(), TrackID: tid.String(), Lang: "vi", Kind: "voiceover"},
	}
}

// makeAudio writes a stereo FLAC of the given length with ffmpeg's sine source.
func makeAudio(t *testing.T, ffmpeg, dir string, seconds string) []byte {
	t.Helper()
	out := filepath.Join(dir, "in.flac")
	cmd := exec.Command(ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration="+seconds,
		"-ac", "2", "-c:a", "flac", out)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("make audio: %v %s", err, b)
	}
	data, err := readFile(out)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestProcessEncodesUploadsAndRewritesMaster(t *testing.T) {
	tools := testutil.ToolsFromEnv(t)
	e := newEnv(t, tools)
	e.objs.Put(e.track.RawBucket, e.track.RawKey, makeAudio(t, tools.FFmpeg, t.TempDir(), "8.05"))

	res := e.job.Process(context.Background(), e.ev, 1)
	if res.Action != Ack || len(e.store.failures) != 0 {
		t.Fatalf("result %+v failures %+v", res, e.store.failures)
	}
	prefix := "v/" + e.track.VideoID.String() + "/audio/" + e.track.ID.String() + "/"
	if len(e.store.completed) != 1 || e.store.completed[0] != prefix+"index.m3u8" {
		t.Fatalf("completed %v", e.store.completed)
	}
	var segs int
	for _, k := range e.objs.Keys("winkey-media") {
		if strings.HasPrefix(k, prefix) && strings.HasSuffix(k, ".m4s") {
			segs++
		}
	}
	pl, ok := e.objs.Get("winkey-media", prefix+"index.m3u8")
	init, okInit := e.objs.Get("winkey-media", prefix+"init.mp4")
	if !ok || !okInit || segs < 2 || pl.ContentType != hlsmaster.ContentType || init.ContentType != "video/mp4" ||
		pl.CacheControl != CacheImmutableForTest || !strings.Contains(string(pl.Data), "#EXT-X-MAP:URI=\"init.mp4\"") {
		t.Fatalf("output: playlist %v %q, init %v, %d segments", ok, pl.Data, okInit, segs)
	}

	// The raw upload is gone once the track is READY (only the HLS output is used).
	if _, ok := e.objs.Get(e.track.RawBucket, e.track.RawKey); ok {
		t.Fatal("raw audio kept after the track became READY")
	}

	// The master: a new key next to the old one, with the audio group pointing at the track.
	if !strings.HasPrefix(e.store.master, "v/"+e.track.VideoID.String()+"/a1/hls/master-") {
		t.Fatalf("master key %q", e.store.master)
	}
	m, _ := e.objs.Get("winkey-media", e.store.master)
	body := string(m.Data)
	if !strings.Contains(body, `NAME="`+hlsmaster.OriginalLabel+`",DEFAULT=YES`) ||
		!strings.Contains(body, `LANGUAGE="vi",NAME="Thuyết minh",DEFAULT=NO,AUTOSELECT=YES,URI="../../audio/`+e.track.ID.String()+`/index.m3u8"`) ||
		!strings.Contains(body, `,AUDIO="aud"`) {
		t.Fatalf("master:\n%s", body)
	}
}

func TestProcessRejectsWrongDurationAndBadFiles(t *testing.T) {
	tools := testutil.ToolsFromEnv(t)

	e := newEnv(t, tools)
	e.objs.Put(e.track.RawBucket, e.track.RawKey, makeAudio(t, tools.FFmpeg, t.TempDir(), "8.5"))
	if res := e.job.Process(context.Background(), e.ev, 1); res.Action != Ack {
		t.Fatalf("%+v", res)
	}
	if len(e.store.failures) != 1 || e.store.failures[0].Reason != ReasonDurationMismatch || e.store.failures[0].Retryable ||
		!strings.Contains(e.store.failures[0].Message, "8.50 s") || len(e.store.completed) != 0 {
		t.Fatalf("failures %+v", e.store.failures)
	}
	if _, ok := e.objs.Get(e.track.RawBucket, e.track.RawKey); !ok {
		t.Fatal("raw audio of a FAILED track deleted")
	}

	e = newEnv(t, tools)
	e.objs.Put(e.track.RawBucket, e.track.RawKey, []byte("this is not audio"))
	e.job.Process(context.Background(), e.ev, 1)
	if len(e.store.failures) != 1 || e.store.failures[0].Reason != ReasonInvalidInput {
		t.Fatalf("failures %+v", e.store.failures)
	}
	if strings.Contains(e.store.failures[0].Message, "/") {
		t.Errorf("the owner-facing message leaks a path: %q", e.store.failures[0].Message)
	}
}

// stubMedia never runs ffmpeg: for the branches that do not reach it.
type stubMedia struct{ Media }

func TestProcessOutcomes(t *testing.T) {
	ctx := context.Background()

	e := newEnv(t, stubMedia{})
	e.store.outcome = Skip
	if res := e.job.Process(ctx, e.ev, 1); res.Action != Ack || len(e.store.failures) != 0 {
		t.Fatalf("skip: %+v", res)
	}

	e.store.outcome = Wait
	if res := e.job.Process(ctx, e.ev, 3); res.Action != Nak || res.Delay != WaitDelay {
		t.Fatalf("wait: %+v", res)
	}
	if res := e.job.Process(ctx, e.ev, MaxDeliveries); res.Action != Ack || len(e.store.failures) != 1 || e.store.failures[0].Reason != ReasonInternal {
		t.Fatalf("wait past the limit: %+v %+v", res, e.store.failures)
	}

	e = newEnv(t, stubMedia{})
	e.store.outcome = VideoFailed
	if res := e.job.Process(ctx, e.ev, 1); res.Action != Ack || len(e.store.failures) != 1 || e.store.failures[0].Retryable {
		t.Fatalf("video failed: %+v %+v", res, e.store.failures)
	}

	e = newEnv(t, stubMedia{})
	e.store.beginErr = errors.New("db down")
	if res := e.job.Process(ctx, e.ev, 1); res.Action != Nak || res.Delay != RetryDelay || len(e.store.failures) != 0 {
		t.Fatalf("transient: %+v", res)
	}

	e = newEnv(t, stubMedia{}) // the raw object is missing: a storage error, retried
	if res := e.job.Process(ctx, e.ev, 1); res.Action != Nak {
		t.Fatalf("missing source: %+v", res)
	}
	if res := e.job.Process(ctx, e.ev, MaxDeliveries); res.Action != Ack || e.store.failures[0].Reason != ReasonStorage {
		t.Fatalf("missing source at the limit: %+v %+v", res, e.store.failures)
	}

	e = newEnv(t, stubMedia{})
	if res := e.job.Process(ctx, UploadedEvent{TrackID: "nope"}, 1); res.Action != Ack {
		t.Fatalf("bad id: %+v", res)
	}
}

// A track deleted while it was encoding: the output is removed, the message acked.
func TestProcessDiscardsOutputOfDeletedTrack(t *testing.T) {
	tools := testutil.ToolsFromEnv(t)
	e := newEnv(t, tools)
	e.store.completeOK = false
	e.objs.Put(e.track.RawBucket, e.track.RawKey, makeAudio(t, tools.FFmpeg, t.TempDir(), "8"))
	if res := e.job.Process(context.Background(), e.ev, 1); res.Action != Ack {
		t.Fatalf("%+v", res)
	}
	for _, k := range e.objs.Keys("winkey-media") {
		if strings.Contains(k, "/audio/") {
			t.Errorf("left behind: %s", k)
		}
	}
}
