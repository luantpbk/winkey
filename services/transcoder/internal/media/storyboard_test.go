package media

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestStoryboardInterval(t *testing.T) {
	for _, c := range []struct{ dur, want float64 }{
		{3, 2}, {60, 2}, {400, 2}, // up to 400 s: the 2 s floor
		{401, 2.005}, {1000, 5}, {3600, 18}, {7200, 36}, {36000, 180},
	} {
		if got := StoryboardInterval(c.dur); got != c.want {
			t.Errorf("interval(%v) = %v, want %v", c.dur, got, c.want)
		}
	}
}

func TestStoryboardFramesNeverExceed200AndAreAtLeastOne(t *testing.T) {
	for _, dur := range []float64{0.1, 0.9, 1, 3, 12.5, 400, 401, 3599.9, 7200, 7200.4, 86400, 1e6} {
		n := StoryboardFrames(dur, StoryboardInterval(dur))
		if n < 1 || n > StoryboardMaxCues {
			t.Errorf("duration %v: %d frames", dur, n)
		}
	}
	if n := StoryboardFrames(7200, StoryboardInterval(7200)); n != 200 {
		t.Errorf("2 h video: %d frames, want 200", n)
	}
	if n := StoryboardFrames(3, 2); n != 2 { // 3 s: frames at 0 s and 2 s
		t.Errorf("3 s: %d", n)
	}
	if n := StoryboardFrames(12, 2); n != 6 { // a multiple: no empty cue at the end
		t.Errorf("12 s: %d", n)
	}
	if n := StoryboardFrames(12.5, 2); n != 7 {
		t.Errorf("12.5 s: %d", n)
	}
	if n := StoryboardFrames(0.4, 2); n != 1 {
		t.Errorf("0.4 s: %d", n)
	}
}

func TestStoryboardTile(t *testing.T) {
	for _, c := range []struct {
		i    int
		file string
		x, y int
	}{
		{0, "sheet-001.jpg", 0, 0},
		{1, "sheet-001.jpg", 160, 0},
		{9, "sheet-001.jpg", 1440, 0},
		{10, "sheet-001.jpg", 0, 90},
		{99, "sheet-001.jpg", 1440, 810},
		{100, "sheet-002.jpg", 0, 0},
		{199, "sheet-002.jpg", 1440, 810},
	} {
		f, x, y := StoryboardTile(c.i)
		if f != c.file || x != c.x || y != c.y {
			t.Errorf("tile %d = %s %d,%d, want %s %d,%d", c.i, f, x, y, c.file, c.x, c.y)
		}
	}
	for frames, sheets := range map[int]int{1: 1, 100: 1, 101: 2, 200: 2} {
		if got := StoryboardSheets(frames); got != sheets {
			t.Errorf("%d frames need %d sheets, got %d", frames, sheets, got)
		}
	}
}

func TestStoryboardVTTShortVideoHasOneCue(t *testing.T) {
	got := BuildStoryboardVTT(0.8, StoryboardInterval(0.8))
	want := "WEBVTT\n\n00:00:00.000 --> 00:00:00.800\nsheet-001.jpg#xywh=0,0,160,90\n\n"
	if got != want {
		t.Fatalf("got:\n%s", got)
	}
}

func TestStoryboardVTTThreeSecondVideo(t *testing.T) {
	got := BuildStoryboardVTT(3, 2)
	want := "WEBVTT\n\n" +
		"00:00:00.000 --> 00:00:02.000\nsheet-001.jpg#xywh=0,0,160,90\n\n" +
		"00:00:02.000 --> 00:00:03.000\nsheet-001.jpg#xywh=160,0,160,90\n\n"
	if got != want {
		t.Fatalf("got:\n%s", got)
	}
}

// Duration not a multiple of the interval: the last cue ends with the video, never past it.
func TestStoryboardVTTDurationNotAMultipleOfTheInterval(t *testing.T) {
	got := BuildStoryboardVTT(12.5, 2)
	cues := strings.Split(strings.TrimSpace(got), "\n\n")[1:]
	if len(cues) != 7 {
		t.Fatalf("%d cues:\n%s", len(cues), got)
	}
	if last := cues[6]; !strings.HasPrefix(last, "00:00:12.000 --> 00:00:12.500\nsheet-001.jpg#xywh=960,0,160,90") {
		t.Fatalf("last cue %q", last)
	}
}

func TestStoryboardVTTTwoHourVideo(t *testing.T) {
	dur := 7200.0
	got := BuildStoryboardVTT(dur, StoryboardInterval(dur))
	cues := strings.Split(strings.TrimSpace(got), "\n\n")[1:]
	if len(cues) != 200 {
		t.Fatalf("%d cues", len(cues))
	}
	if !strings.HasPrefix(cues[0], "00:00:00.000 --> 00:00:36.000\nsheet-001.jpg#xywh=0,0,160,90") ||
		!strings.HasPrefix(cues[100], "01:00:00.000 --> 01:00:36.000\nsheet-002.jpg#xywh=0,0,160,90") ||
		!strings.HasPrefix(cues[199], "01:59:24.000 --> 02:00:00.000\nsheet-002.jpg#xywh=1440,810,160,90") {
		t.Fatalf("cues: %q ... %q ... %q", cues[0], cues[100], cues[199])
	}
}

// Cues are contiguous, ordered, start at 0, end at the duration; every payload is a relative name.
func TestStoryboardVTTIsContiguousAndRelative(t *testing.T) {
	for _, dur := range []float64{1, 2, 2.4, 7, 61.3, 399, 401, 1234.5, 5000} {
		got := BuildStoryboardVTT(dur, StoryboardInterval(dur))
		if !strings.HasPrefix(got, "WEBVTT\n\n") {
			t.Fatal(got)
		}
		prevEnd := "00:00:00.000"
		lines := strings.Split(strings.TrimSpace(got), "\n")
		for i := 2; i+1 < len(lines); i += 3 {
			timing, payload := lines[i], lines[i+1]
			start, end, ok := strings.Cut(timing, " --> ")
			if !ok || start != prevEnd || end <= start {
				t.Fatalf("dur %v: cue %q after end %s", dur, timing, prevEnd)
			}
			prevEnd = end
			if strings.HasPrefix(payload, "/") || strings.Contains(payload, "://") || !strings.HasPrefix(payload, "sheet-") ||
				!strings.Contains(payload, ".jpg#xywh=") || !strings.HasSuffix(payload, ",160,90") {
				t.Fatalf("payload %q", payload)
			}
		}
		if prevEnd != vttTime(dur) {
			t.Errorf("dur %v: track ends at %s, want %s", dur, prevEnd, vttTime(dur))
		}
	}
}

func TestBuildStoryboardArgs(t *testing.T) {
	// Paths are built for the OS the test runs on and compared in the slash form ffmpeg gets.
	in := filepath.Join(t.TempDir(), "in", "source")
	out := filepath.Join(t.TempDir(), "storyboard")
	a := strings.Join(BuildStoryboardArgs(in, out, 2, false), " ")
	for _, want := range []string{
		"-i " + filepath.ToSlash(in), "-an", "-protocol_whitelist file",
		"fps=fps=1/2:eof_action=pass,scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2,tile=10x10,format=yuvj420p",
		"-q:v 6", filepath.ToSlash(out) + "/sheet-%03d.jpg",
	} {
		if !strings.Contains(a, want) {
			t.Errorf("missing %q in %s", want, a)
		}
	}
	if strings.Contains(a, "hwaccel") || strings.Contains(a, "skip_frame") {
		t.Errorf("a plain source is decoded on the CPU, every frame: %s", a)
	}
	// HLS renditions: key frames only, an input option (before -i); still no GPU.
	k := strings.Join(BuildStoryboardArgs(in, out, 2.005, true), " ")
	if i := strings.Index(k, "-skip_frame nokey"); i < 0 || i > strings.Index(k, "-i ") ||
		!strings.Contains(k, "fps=fps=1/2.005:") || strings.Contains(k, "hwaccel") {
		t.Errorf("key frame args: %s", k)
	}
}

func TestStoryboardRenditionIsTheSmallestOfAtLeast90px(t *testing.T) {
	r := func(name string, h int) Rendition { return Rendition{Name: name, Height: h} }
	for _, c := range []struct {
		rs   []Rendition
		want string
	}{
		{[]Rendition{r("1080p", 1080), r("720p", 720), r("480p", 480)}, "480p"},
		{[]Rendition{r("480p", 480), r("1080p", 1080)}, "480p"}, // order does not matter
		{[]Rendition{r("360p", 360)}, "360p"},
		{[]Rendition{r("90p", 90)}, "90p"},
		{[]Rendition{r("64p", 64)}, ""},                     // too small: read the source
		{[]Rendition{r("720p", 720), r("64p", 64)}, "720p"}, // a small one is skipped
		{nil, ""},
	} {
		got, ok := StoryboardRendition(c.rs)
		if (c.want == "") == ok || got.Name != c.want && ok {
			t.Errorf("%+v: %q %v, want %q", c.rs, got.Name, ok, c.want)
		}
	}
}
