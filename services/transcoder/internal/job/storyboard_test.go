package job_test

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/jpeg"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"log/slog"

	"github.com/luantpbk/winkey/services/transcoder/internal/job"
	"github.com/luantpbk/winkey/services/transcoder/internal/media"
	"github.com/luantpbk/winkey/services/transcoder/internal/testutil"
)

// litTiles counts the tiles of a sheet that hold a picture (a tile that ffmpeg never filled is black).
func litTiles(t *testing.T, sheet []byte) (lit int, b image.Rectangle) {
	t.Helper()
	img, err := jpeg.Decode(bytes.NewReader(sheet))
	if err != nil {
		t.Fatalf("sheet is not a JPEG: %v", err)
	}
	b = img.Bounds()
	for i := 0; i < media.StoryboardPerSheet; i++ {
		x0, y0 := (i%media.StoryboardCols)*media.StoryboardTileW, (i/media.StoryboardCols)*media.StoryboardTileH
		var sum, n int
		for y := y0; y < y0+media.StoryboardTileH; y += 3 {
			for x := x0; x < x0+media.StoryboardTileW; x += 3 {
				r, g, bl, _ := img.At(x, y).RGBA()
				sum += int((r + g + bl) / 3 >> 8)
				n++
			}
		}
		if sum/n > 8 {
			lit++
		}
	}
	return lit, b
}

func TestProcessUploadsTheStoryboard(t *testing.T) {
	f, _ := newFlow(t, media.EncoderX264, testutil.ClipSilent) // 12 s, 1920x1080
	res := f.Pipeline.Process(context.Background(), f.Event(), job.Delivery{Num: 1, Max: 3})
	if res.Action != job.ActionAck || res.Stats == nil || !res.Stats.Storyboard || res.Stats.StoryboardWall <= 0 {
		t.Fatalf("%+v", res)
	}
	prefix := fmt.Sprintf("v/%s/a1/", f.Video.ID)
	if len(f.Store.Ready) != 1 || f.Store.Ready[0].StoryboardKey != prefix+"storyboard/storyboard.vtt" {
		t.Fatalf("ready: %+v", f.Store.Ready)
	}

	// Objects, content types, cache headers.
	var got []string
	for _, k := range f.Objs.Keys(testutil.MediaBucket) {
		if rest, ok := strings.CutPrefix(k, prefix+"storyboard/"); ok {
			got = append(got, rest)
		}
	}
	if strings.Join(got, ",") != "sheet-001.jpg,storyboard.vtt" { // 12 s at 2 s: 6 frames, one sheet
		t.Fatalf("storyboard objects: %v", got)
	}
	vtt, _ := f.Objs.Get(testutil.MediaBucket, prefix+"storyboard/storyboard.vtt")
	sheet, _ := f.Objs.Get(testutil.MediaBucket, prefix+"storyboard/sheet-001.jpg")
	if vtt.ContentType != "text/vtt" || sheet.ContentType != "image/jpeg" {
		t.Errorf("content types: %q %q", vtt.ContentType, sheet.ContentType)
	}
	for _, o := range []testutil.Object{vtt, sheet} {
		if o.CacheControl != "public, max-age=31536000, immutable" {
			t.Errorf("cache-control %q", o.CacheControl)
		}
	}

	// The track: 6 cues of 2 s that point into the sheet by relative names, and the sheet holds exactly 6 pictures.
	text := string(vtt.Data)
	if !strings.HasPrefix(text, "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nsheet-001.jpg#xywh=0,0,160,90\n\n") ||
		!strings.Contains(text, "00:00:10.000 --> 00:00:12.0") || strings.Count(text, "#xywh=") != 6 {
		t.Fatalf("vtt:\n%s", text)
	}
	if strings.Contains(text, "http") || strings.Contains(text, "/v/") {
		t.Fatalf("names must be relative:\n%s", text)
	}
	lit, size := litTiles(t, sheet.Data)
	if size.Dx() != 1600 || size.Dy() != 900 || lit != 6 {
		t.Fatalf("sheet %v with %d lit tiles, want 1600x900 and 6", size, lit)
	}
}

// The number of frames the track promises must equal what ffmpeg really delivers, for any duration.
func TestStoryboardFramesMatchWhatFfmpegDelivers(t *testing.T) {
	tools := testutil.ToolsFromEnv(t)
	dir := t.TempDir()
	for _, dur := range []float64{0.4, 0.8, 1, 2, 2.9, 3, 5, 7.5, 11.96, 12, 12.04, 12.08, 12.5, 13.9, 30} {
		clip := filepath.Join(dir, fmt.Sprintf("c%v.mp4", dur))
		if b, err := exec.Command(tools.FFmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25",
			"-t", fmt.Sprint(dur), "-c:v", "libx264", "-preset", "ultrafast", clip).CombinedOutput(); err != nil {
			t.Fatalf("%v\n%s", err, b)
		}
		info, err := tools.Probe(context.Background(), clip)
		if err != nil {
			t.Fatal(err)
		}
		out := filepath.Join(dir, fmt.Sprintf("o%v", dur))
		r, err := tools.Storyboard(context.Background(), clip, out, info.DurationSec, false)
		if err != nil {
			t.Fatalf("%vs: %v", dur, err)
		}
		data, _ := os.ReadFile(filepath.Join(out, "sheet-001.jpg"))
		if lit, _ := litTiles(t, data); lit != r.Frames {
			t.Errorf("%vs (probed %.3f): the track lists %d frames, the sheet holds %d", dur, info.DurationSec, r.Frames, lit)
		}
	}
}

func TestStoryboardOfALongVideoUsesTwoSheets(t *testing.T) {
	tools := testutil.ToolsFromEnv(t)
	dir := t.TempDir()
	clip := filepath.Join(dir, "long.mp4") // 250 s: interval 2 s, 125 frames, 2 sheets
	if b, err := exec.Command(tools.FFmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=5",
		"-t", "250", "-c:v", "libx264", "-preset", "ultrafast", clip).CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, b)
	}
	info, err := tools.Probe(context.Background(), clip)
	if err != nil {
		t.Fatal(err)
	}
	r, err := tools.Storyboard(context.Background(), clip, filepath.Join(dir, "sb"), info.DurationSec, false)
	if err != nil || r.Frames != 125 || r.Sheets != 2 {
		t.Fatalf("%+v %v", r, err)
	}
	s1, _ := os.ReadFile(filepath.Join(dir, "sb", "sheet-001.jpg"))
	s2, _ := os.ReadFile(filepath.Join(dir, "sb", "sheet-002.jpg"))
	if l1, _ := litTiles(t, s1); l1 != 100 {
		t.Errorf("sheet 1: %d lit tiles", l1)
	}
	if l2, _ := litTiles(t, s2); l2 != 25 {
		t.Errorf("sheet 2: %d lit tiles", l2)
	}
	if _, err := os.Stat(filepath.Join(dir, "sb", "sheet-003.jpg")); err == nil {
		t.Error("an extra sheet must not be kept")
	}
	vtt, _ := os.ReadFile(filepath.Join(dir, "sb", "storyboard.vtt"))
	if !regexp.MustCompile(`(?m)^sheet-002\.jpg#xywh=0,0,160,90$`).Match(vtt) || strings.Count(string(vtt), "#xywh=") != 125 {
		t.Errorf("vtt has %d cues", strings.Count(string(vtt), "#xywh="))
	}
}

func TestStoryboardKeepsTheAspectWithBlackBars(t *testing.T) {
	f, _ := newFlow(t, media.EncoderX264, testutil.ClipPortrait) // 1080x1920: 51x90 picture, bars left and right
	if res := f.Pipeline.Process(context.Background(), f.Event(), job.Delivery{Num: 1, Max: 3}); res.Action != job.ActionAck {
		t.Fatalf("%+v", res)
	}
	sheet, ok := f.Objs.Get(testutil.MediaBucket, fmt.Sprintf("v/%s/a1/storyboard/sheet-001.jpg", f.Video.ID))
	if !ok {
		t.Fatal("no sheet")
	}
	img, err := jpeg.Decode(bytes.NewReader(sheet.Data))
	if err != nil {
		t.Fatal(err)
	}
	lum := func(x, y int) int { r, g, b, _ := img.At(x, y).RGBA(); return int((r + g + b) / 3 >> 8) }
	if lum(4, 45) > 20 || lum(155, 45) > 20 { // bars
		t.Errorf("the bars of the first tile are not black: %d %d", lum(4, 45), lum(155, 45))
	}
	if lum(80, 45) < 12 && lum(70, 20) < 12 && lum(90, 70) < 12 {
		t.Error("the picture of the first tile is empty")
	}
}

// Best effort: a failing storyboard must not fail or delay the video. It becomes READY without
// one, with a warning that names the video, and nothing of it is uploaded.
func TestProcessWithoutStoryboardWhenFfmpegFails(t *testing.T) {
	f, _ := newFlow(t, media.EncoderX264, testutil.ClipSmall)
	var logs bytes.Buffer
	f.Pipeline.Log = slog.New(slog.NewJSONHandler(&logs, nil))
	calls := 0
	f.Pipeline.Storyboard = func(ctx context.Context, input, dir string, dur float64, hw bool) (job.StoryboardResult, error) {
		calls++
		_ = os.MkdirAll(dir, 0o755)
		_ = os.WriteFile(filepath.Join(dir, "sheet-001.jpg"), []byte("half written"), 0o644) // debris must not be uploaded
		return job.StoryboardResult{}, &job.EncoderError{Op: "ffmpeg storyboard", Err: fmt.Errorf("exit status 1"), Tail: "boom"}
	}
	res := f.Pipeline.Process(context.Background(), f.Event(), job.Delivery{Num: 1, Max: 3})
	if res.Action != job.ActionAck || res.Stats == nil || res.Stats.Storyboard {
		t.Fatalf("%+v", res)
	}
	if calls != 1 || len(f.Store.Ready) != 1 || len(f.Store.Fails) != 0 || f.Store.Ready[0].StoryboardKey != "" {
		t.Fatalf("calls=%d ready=%+v fails=%v", calls, f.Store.Ready, f.Store.Fails)
	}
	for _, k := range f.Objs.Keys(testutil.MediaBucket) {
		if strings.Contains(k, "storyboard") {
			t.Errorf("uploaded %s", k)
		}
	}
	if _, ok := f.Objs.Get(testutil.MediaBucket, f.Store.Ready[0].MasterKey); !ok {
		t.Error("the video itself must be published")
	}
	warn := regexp.MustCompile(`"level":"WARN","msg":"storyboard failed; continuing without it","video_id":"` + f.Video.ID.String() + `"`)
	if !warn.MatchString(logs.String()) {
		t.Fatalf("no warn naming the video:\n%s", logs.String())
	}
}

func TestToolsStoryboardFailsOnUnreadableInput(t *testing.T) {
	tools := testutil.ToolsFromEnv(t)
	junk := filepath.Join(t.TempDir(), "junk")
	_ = os.WriteFile(junk, []byte("not a video"), 0o644)
	if _, err := tools.Storyboard(context.Background(), junk, filepath.Join(t.TempDir(), "sb"), 10, false); err == nil {
		t.Fatal("want an error")
	}
	if _, err := tools.Storyboard(context.Background(), junk, t.TempDir(), 0, false); err == nil {
		t.Fatal("an unknown duration must be refused")
	}
}

// An interrupted job (shutdown) is given back like at any other step, never turned into "no storyboard".
func TestProcessShutdownDuringStoryboardIsNotSwallowed(t *testing.T) {
	f, _ := newFlow(t, media.EncoderX264, testutil.ClipSmall)
	ctx, cancel := context.WithCancel(context.Background())
	f.Pipeline.Storyboard = func(ctx context.Context, _, _ string, _ float64, _ bool) (job.StoryboardResult, error) {
		cancel()
		return job.StoryboardResult{}, ctx.Err()
	}
	res := f.Pipeline.Process(ctx, f.Event(), job.Delivery{Num: 1, Max: 3})
	if res.Action != job.ActionNak || len(f.Store.Ready) != 0 {
		t.Fatalf("%+v ready=%d", res, len(f.Store.Ready))
	}
}
