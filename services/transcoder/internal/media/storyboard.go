package media

import (
	"fmt"
	"math"
	"path/filepath"
	"strconv"
	"strings"
)

// Seek-preview storyboard (task V5a): sprite sheets of small frames plus a WebVTT
// track whose cues point at them with #xywh=x,y,w,h (the format hls.js and the
// video.js thumbnail plugins read). Every name in the track is RELATIVE, so the signed
// URL prefix of SEC1 (/s/{exp}/{sig}/...) applies to the sheets without rewriting.
const (
	StoryboardTileW    = 160
	StoryboardTileH    = 90
	StoryboardCols     = 10
	StoryboardRows     = 10
	StoryboardPerSheet = StoryboardCols * StoryboardRows
	StoryboardMinStep  = 2.0 // seconds between frames, at least
	StoryboardMaxCues  = 200 // frames per video, at most
	StoryboardQuality  = 6   // ffmpeg -q:v, about JPEG quality 75
	StoryboardVTT      = "storyboard.vtt"
	StoryboardSheetFmt = "sheet-%03d.jpg" // sheets are numbered from 1
)

// StoryboardInterval is the time between two frames: max(2 s, duration / 200), in
// whole milliseconds so ffmpeg and the WebVTT track use the same number.
func StoryboardInterval(durationSec float64) float64 {
	iv := math.Max(StoryboardMinStep, durationSec/StoryboardMaxCues)
	return math.Round(iv*1000) / 1000
}

// StoryboardFrames is how many frames the fps=1/interval,eof_action=pass filter of ffmpeg
// delivers: one per started interval, ceil(duration / interval) (checked against real ffmpeg
// in the job tests), at least 1 and at most 200.
func StoryboardFrames(durationSec, interval float64) int {
	n := int(math.Ceil(durationSec/interval - 1e-9))
	return max(1, min(n, StoryboardMaxCues))
}

// StoryboardSheets is the number of sprite sheets needed for n frames.
func StoryboardSheets(frames int) int { return (frames + StoryboardPerSheet - 1) / StoryboardPerSheet }

// StoryboardTile locates frame i: the sheet file name and the tile rectangle in it.
func StoryboardTile(i int) (sheet string, x, y int) {
	t := i % StoryboardPerSheet
	return fmt.Sprintf(StoryboardSheetFmt, i/StoryboardPerSheet+1),
		(t % StoryboardCols) * StoryboardTileW, (t / StoryboardCols) * StoryboardTileH
}

// BuildStoryboardVTT writes the WebVTT track: one cue per frame, cue i starting at
// i*interval and ending at min((i+1)*interval, duration); the last cue ends with the
// video. Frames the video never reaches are not listed.
func BuildStoryboardVTT(durationSec, interval float64) string {
	n := StoryboardFrames(durationSec, interval)
	var b strings.Builder
	b.WriteString("WEBVTT\n\n")
	for i := 0; i < n; i++ {
		start := float64(i) * interval
		end := math.Min(float64(i+1)*interval, durationSec) // the last cue ends with the video
		sheet, x, y := StoryboardTile(i)
		fmt.Fprintf(&b, "%s --> %s\n%s#xywh=%d,%d,%d,%d\n\n",
			vttTime(start), vttTime(end), sheet, x, y, StoryboardTileW, StoryboardTileH)
	}
	return b.String()
}

// vttTime formats seconds as HH:MM:SS.mmm.
func vttTime(sec float64) string {
	ms := int64(math.Round(sec * 1000))
	return fmt.Sprintf("%02d:%02d:%02d.%03d", ms/3_600_000, ms/60_000%60, ms/1000%60, ms%1000)
}

// StoryboardMinSourceHeight is the smallest rendition worth reading: a tile is 90 px high.
const StoryboardMinSourceHeight = StoryboardTileH

// StoryboardRendition picks the rendition the storyboard is read from: the one with the smallest
// height that is still at least 90 px. ok is false when none qualifies (the source is read then).
func StoryboardRendition(rs []Rendition) (best Rendition, ok bool) {
	for _, r := range rs {
		if r.Height >= StoryboardMinSourceHeight && (!ok || r.Height < best.Height) {
			best, ok = r, true
		}
	}
	return best, ok
}

// BuildStoryboardArgs returns the ffmpeg arguments for ONE call that writes every sheet
// (outDir/sheet-001.jpg, ...): one frame per interval, letter-boxed to 160x90 (aspect
// kept, black bars), tiled 10x10, decoded on the CPU. keyframesOnly (-skip_frame nokey) is for the HLS
// renditions of this worker, which have a key frame every 2 s. eof_action=pass delivers the frame of a video shorter than one
// interval; the closing format=yuvj420p is what the JPEG encoder of recent ffmpeg versions accepts
// (it refuses limited-range YUV, which many sources carry).
func BuildStoryboardArgs(input, outDir string, interval float64, keyframesOnly bool) []string {
	a := []string{"-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-protocol_whitelist", "file"}
	if keyframesOnly {
		a = append(a, "-skip_frame", "nokey")
	}
	vf := fmt.Sprintf("fps=fps=1/%s:eof_action=pass,scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2,tile=%dx%d,format=yuvj420p",
		strconv.FormatFloat(interval, 'f', -1, 64),
		StoryboardTileW, StoryboardTileH, StoryboardTileW, StoryboardTileH, StoryboardCols, StoryboardRows)
	return append(a,
		"-i", filepath.ToSlash(input),
		"-an", "-sn", "-vf", vf,
		"-q:v", strconv.Itoa(StoryboardQuality),
		filepath.ToSlash(outDir)+"/"+StoryboardSheetFmt)
}
