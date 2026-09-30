package job

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/luantpbk/winkey/services/transcoder/internal/media"
)

// StoryboardResult describes what Tools.Storyboard wrote.
type StoryboardResult struct {
	Frames   int     // cues in the WebVTT track
	Sheets   int     // sprite sheets written
	Interval float64 // seconds between frames
}

// StoryboardFunc produces the storyboard of the local file input in dir (sheet-NNN.jpg +
// storyboard.vtt). Pipeline.Storyboard may replace it (tests); the default is Tools.Storyboard.
type StoryboardFunc func(ctx context.Context, input, dir string, durationSec float64, hwDecode bool) (StoryboardResult, error)

// storyboardTimeout is the time budget of the single ffmpeg run: decoding the whole video
// once, max(2 min, duration). A slow storyboard must not hold up a video that is already
// encoded, so the budget is short; the step is best effort.
func storyboardTimeout(durationSec float64) time.Duration {
	return max(2*time.Minute, time.Duration(durationSec*float64(time.Second)))
}

// Storyboard writes the seek-preview storyboard (task V5a) of input into dir with ONE ffmpeg
// call and a WebVTT track whose cues point at the sheets by relative name. It verifies that
// every sheet the track refers to exists; sheets ffmpeg wrote beyond that are removed.
func (t Tools) Storyboard(ctx context.Context, input, dir string, durationSec float64, hwDecode bool) (StoryboardResult, error) {
	if durationSec <= 0 {
		return StoryboardResult{}, errors.New("storyboard: unknown duration")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return StoryboardResult{}, err
	}
	interval := media.StoryboardInterval(durationSec)
	frames := media.StoryboardFrames(durationSec, interval)
	sheets := media.StoryboardSheets(frames)

	rctx, cancel := context.WithTimeout(ctx, storyboardTimeout(durationSec))
	defer cancel()
	var errTail tailBuffer
	cmd := exec.CommandContext(rctx, t.FFmpeg, media.BuildStoryboardArgs(input, dir, interval, hwDecode)...)
	cmd.Stderr = &errTail
	cmd.WaitDelay = 10 * time.Second
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil { // shutdown
			return StoryboardResult{}, ctx.Err()
		}
		if errors.Is(rctx.Err(), context.DeadlineExceeded) {
			return StoryboardResult{}, &TimeoutError{After: storyboardTimeout(durationSec).String()}
		}
		return StoryboardResult{}, &EncoderError{Op: "ffmpeg storyboard", Err: err, Tail: errTail.String()}
	}

	for i := 1; i <= sheets; i++ {
		name := filepath.Join(dir, fmt.Sprintf(media.StoryboardSheetFmt, i))
		if st, err := os.Stat(name); err != nil || st.Size() == 0 {
			return StoryboardResult{}, &EncoderError{Op: "ffmpeg storyboard", Err: fmt.Errorf("sheet %d missing (want %d sheets for %d frames)", i, sheets, frames)}
		}
	}
	for i := sheets + 1; ; i++ { // an extra frame at the end of the stream must not be published
		name := filepath.Join(dir, fmt.Sprintf(media.StoryboardSheetFmt, i))
		if err := os.Remove(name); err != nil {
			break
		}
	}
	if err := os.WriteFile(filepath.Join(dir, media.StoryboardVTT), []byte(media.BuildStoryboardVTT(durationSec, interval)), 0o644); err != nil {
		return StoryboardResult{}, err
	}
	return StoryboardResult{Frames: frames, Sheets: sheets, Interval: interval}, nil
}

// buildStoryboard runs the best-effort step of the pipeline. It returns the media-bucket key of
// storyboard.vtt, or "" when there is no storyboard: any failure is logged at warn (with the
// video id, which the logger carries) and the job goes on. Only a cancelled context (shutdown)
// is an error, so an interrupted job is given back like at any other step.
func (p *Pipeline) buildStoryboard(ctx context.Context, source, outDir, prefix string, durationSec float64, hw bool, logger *slog.Logger) (key string, took time.Duration, err error) {
	gen := p.Storyboard
	if gen == nil {
		gen = p.Tools.Storyboard
	}
	dir := filepath.Join(outDir, "storyboard")
	start := time.Now()
	_, gerr := gen(ctx, source, dir, durationSec, hw)
	if gerr != nil && hw && ctx.Err() == nil { // the GPU decoder is optional here: try the CPU
		logger.WarnContext(ctx, "storyboard with hardware decode failed; retrying on the CPU", "error", gerr)
		_ = os.RemoveAll(dir)
		_, gerr = gen(ctx, source, dir, durationSec, false)
	}
	took = time.Since(start)
	if ctx.Err() != nil {
		return "", took, ctx.Err()
	}
	if gerr != nil {
		logger.WarnContext(ctx, "storyboard failed; continuing without it", "error", gerr)
		_ = os.RemoveAll(dir)
		return "", took, nil
	}
	return prefix + "storyboard/" + media.StoryboardVTT, took, nil
}
