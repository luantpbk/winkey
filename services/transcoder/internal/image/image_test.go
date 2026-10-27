package image

import (
	"bytes"
	"context"
	"encoding/binary"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/services/transcoder/internal/job"
	"github.com/luantpbk/winkey/services/transcoder/internal/media"
	"github.com/luantpbk/winkey/services/transcoder/internal/testutil"
)

type fakeStore struct {
	img      Image
	ok       bool
	out      *Output
	failures []string
}

func (s *fakeStore) BeginImage(context.Context, uuid.UUID) (Image, bool, error) {
	return s.img, s.ok, nil
}
func (s *fakeStore) CompleteImage(_ context.Context, _ uuid.UUID, out Output) (bool, error) {
	s.out = &out
	return true, nil
}
func (s *fakeStore) FailImage(_ context.Context, _ uuid.UUID, reason string) (bool, error) {
	s.failures = append(s.failures, reason)
	return true, nil
}

// twoTone writes a w×h JPEG (or PNG) whose left half is red and right half blue.
func twoTone(t *testing.T, tools job.Tools, w, h int, ext string) []byte {
	t.Helper()
	out := filepath.Join(t.TempDir(), "in."+ext)
	half := itoa(w/2) + "x" + itoa(h)
	cmd := exec.Command(tools.FFmpeg, "-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "color=red:s="+half, "-f", "lavfi", "-i", "color=blue:s="+half,
		"-filter_complex", "[0][1]hstack", "-frames:v", "1", out)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("make image: %v %s", err, b)
	}
	data, err := os.ReadFile(out) // #nosec G304 -- test temp file
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func itoa(n int) string { return strconv.Itoa(n) }

// withOrientation splices an EXIF APP1 segment (big-endian TIFF, one Orientation entry) after the SOI.
func withOrientation(jpeg []byte, o uint16) []byte {
	tiff := make([]byte, 26)
	copy(tiff, "MM")
	binary.BigEndian.PutUint16(tiff[2:], 42)
	binary.BigEndian.PutUint32(tiff[4:], 8)
	binary.BigEndian.PutUint16(tiff[8:], 1)
	binary.BigEndian.PutUint16(tiff[10:], 0x0112)
	binary.BigEndian.PutUint16(tiff[12:], 3)
	binary.BigEndian.PutUint32(tiff[14:], 1)
	binary.BigEndian.PutUint16(tiff[18:], o)
	seg := append([]byte("Exif\x00\x00"), tiff...)
	app1 := []byte{0xff, 0xe1, 0, 0}
	binary.BigEndian.PutUint16(app1[2:], uint16(len(seg)+2))
	out := append([]byte{}, jpeg[:2]...)
	out = append(append(out, app1...), seg...)
	return append(out, jpeg[2:]...)
}

// topPixel decodes a WebP and returns the RGB of its top-centre pixel.
func topPixel(t *testing.T, tools job.Tools, webp []byte) [3]byte {
	t.Helper()
	in := filepath.Join(t.TempDir(), "o.webp")
	if err := os.WriteFile(in, webp, 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(tools.FFmpeg, "-hide_banner", "-loglevel", "error", "-i", in,
		"-vf", "format=rgb24,crop=2:2:iw/2:2", "-f", "rawvideo", "-pix_fmt", "rgb24", "-")
	out, err := cmd.Output()
	if err != nil || len(out) < 3 {
		t.Fatalf("decode: %v %d", err, len(out))
	}
	return [3]byte{out[0], out[1], out[2]}
}

func newJob(t *testing.T, tools job.Tools, purpose string, raw []byte) (*Job, *fakeStore, *testutil.MemObjects, Image) {
	t.Helper()
	img := Image{ID: uuid.Must(uuid.NewV7()), OwnerID: uuid.Must(uuid.NewV7()), Purpose: purpose, RawBucket: "winkey-raw"}
	img.RawKey = img.OwnerID.String() + "/images/" + img.ID.String()
	objs := testutil.NewMemObjects()
	objs.Put(img.RawBucket, img.RawKey, raw)
	st := &fakeStore{img: img, ok: true}
	return &Job{Store: st, Objects: objs, Media: tools, MediaBucket: "winkey-media", WorkDir: t.TempDir(),
		Log: slog.New(slog.NewJSONHandler(io.Discard, nil))}, st, objs, img
}

func run(j *Job, img Image) Result {
	return j.Process(context.Background(), UploadedEvent{ImageID: img.ID.String()}, 1)
}

func TestPostImageIsUprightWebPWithoutMetadata(t *testing.T) {
	tools := testutil.ToolsFromEnv(t)
	if !tools.HasWebPEncoder(context.Background()) {
		t.Skip("ffmpeg without libwebp")
	}
	// Stored 2000×1000 with orientation 6: displayed 1000×2000, red on top.
	raw := withOrientation(twoTone(t, tools, 2000, 1000, "jpg"), 6)
	j, st, objs, img := newJob(t, tools, media.PurposePost, raw)
	if res := run(j, img); res.Action != Ack || len(st.failures) != 0 || st.out == nil {
		t.Fatalf("result %+v failures %v", res, st.failures)
	}
	if st.out.Width != 800 || st.out.Height != 1600 {
		t.Fatalf("size %dx%d, want 800x1600 (upright, long edge 1600)", st.out.Width, st.out.Height)
	}
	full, ok := objs.Get("winkey-media", st.out.ImageKey)
	thumb, okT := objs.Get("winkey-media", st.out.ThumbKey)
	if !ok || !okT || full.ContentType != "image/webp" || full.CacheControl != job.CacheImmutable ||
		st.out.ImageKey != "i/"+img.OwnerID.String()+"/"+img.ID.String()+"/image.webp" {
		t.Fatalf("outputs %v %v %+v", ok, okT, st.out)
	}
	if p := topPixel(t, tools, full.Data); p[0] < 200 || p[2] > 60 {
		t.Fatalf("top pixel %v is not red: orientation not applied", p)
	}
	if bytes.Contains(full.Data, []byte("EXIF")) || bytes.Contains(full.Data, []byte("Exif")) {
		t.Fatal("output keeps EXIF")
	}
	if st.out.Bytes != int64(len(full.Data)+len(thumb.Data)) {
		t.Fatalf("bytes %d", st.out.Bytes)
	}
	if _, still := objs.Get(img.RawBucket, img.RawKey); still {
		t.Fatal("raw image kept after READY")
	}
}

func TestAvatarAndBannerSizes(t *testing.T) {
	tools := testutil.ToolsFromEnv(t)
	if !tools.HasWebPEncoder(context.Background()) {
		t.Skip("ffmpeg without libwebp")
	}
	for purpose, want := range map[string][2]int{media.PurposeAvatar: {400, 400}, media.PurposeBanner: {1500, 500}} {
		j, st, _, img := newJob(t, tools, purpose, twoTone(t, tools, 640, 480, "png"))
		if res := run(j, img); res.Action != Ack || st.out == nil {
			t.Fatalf("%s: %+v %v", purpose, res, st.failures)
		}
		if st.out.Width != want[0] || st.out.Height != want[1] {
			t.Fatalf("%s: %dx%d", purpose, st.out.Width, st.out.Height)
		}
	}
}

func TestInvalidImagesFailAndRawIsDeleted(t *testing.T) {
	tools := testutil.ToolsFromEnv(t)
	for name, raw := range map[string][]byte{
		"gif":  []byte("GIF89a\x01\x00\x01\x00"),
		"text": []byte("this is not an image"),
		"truncated jpeg": func() []byte {
			b := twoTone(t, tools, 64, 64, "jpg")
			return b[:40]
		}(),
	} {
		j, st, objs, img := newJob(t, tools, media.PurposePost, raw)
		if res := run(j, img); res.Action != Ack {
			t.Fatalf("%s: %+v", name, res)
		}
		if len(st.failures) != 1 || st.failures[0] != ReasonInvalidInput || st.out != nil {
			t.Fatalf("%s: failures %v out %+v", name, st.failures, st.out)
		}
		if _, still := objs.Get(img.RawBucket, img.RawKey); still {
			t.Fatalf("%s: raw kept after FAILED", name)
		}
	}
}

func TestNotProcessingIsAcked(t *testing.T) {
	j, st, objs, img := newJob(t, job.Tools{}, media.PurposePost, []byte("x"))
	st.ok = false
	if res := run(j, img); res.Action != Ack || st.out != nil || len(st.failures) != 0 {
		t.Fatalf("%+v", res)
	}
	if _, still := objs.Get(img.RawBucket, img.RawKey); !still {
		t.Fatal("raw of an image this job does not own was deleted")
	}
}

func TestStorageErrorsRetryThenFail(t *testing.T) {
	j, st, objs, img := newJob(t, job.Tools{}, media.PurposePost, []byte("x"))
	objs.DownloadErr = io.ErrUnexpectedEOF
	if res := j.Process(context.Background(), UploadedEvent{ImageID: img.ID.String()}, 1); res.Action != Nak || len(st.failures) != 0 {
		t.Fatalf("first: %+v %v", res, st.failures)
	}
	if res := j.Process(context.Background(), UploadedEvent{ImageID: img.ID.String()}, MaxDeliveries); res.Action != Ack ||
		len(st.failures) != 1 || st.failures[0] != ReasonStorage {
		t.Fatalf("last: %+v %v", res, st.failures)
	}
}
