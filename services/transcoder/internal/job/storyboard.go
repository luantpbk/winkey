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

// StoryboardInput is what the storyboard is made from.
type StoryboardInput struct {
	Path string
	// KeyframesOnly decodes only key frames (-skip_frame nokey). It is right for the HLS renditions
	// of this worker, whose key frames are exactly 2 s apart and never further apart than the
	// storyboard interval; it is wrong for an arbitrary source, whose GOP is unknown.
	KeyframesOnly bool
}

// StoryboardFunc produces the storyboard of in in dir (sheet-NNN.jpg + storyboard.vtt).
// Pipeline.Storyboard may replace it (tests); the default is Tools.Storyboard.
type StoryboardFunc func(ctx context.Context, in StoryboardInput, dir string, durationSec float64) (StoryboardResult, error)

// storyboardInput picks the input of the storyboard: the local playlist of the SMALLEST
// rendition that is at least 90 px high (a few key frames of a small picture instead of every
// frame of the source: this is what keeps the step cheap), or the source file when no rendition
// qualifies.
func storyboardInput(rs []media.Rendition, hlsDir, source string) StoryboardInput {
	if r, ok := media.StoryboardRendition(rs); ok {
		return StoryboardInput{Path: filepath.Join(hlsDir, r.Name, "index.m3u8"), KeyframesOnly: true}
	}
	return StoryboardInput{Path: source}
}

// storyboardTimeout is the time budget of the single ffmpeg run, max(2 min, duration). A slow
// storyboard must not hold up a video that is already encoded, so it is short; the step is best effort.
func storyboardTimeout(durationSec float64) time.Duration {
	return max(2*time.Minute, time.Duration(durationSec*float64(time.Second)))
}

// Storyboard writes the seek-preview storyboard (task V5a) into dir with ONE ffmpeg call on the CPU and
// a WebVTT track whose cues point at the sheets by relative name. It verifies that every sheet the
// track refers to exists; sheets ffmpeg wrote beyond that are removed.
func (t Tools) Storyboard(ctx context.Context, in StoryboardInput, dir string, durationSec float64) (StoryboardResult, error) {
	if durationSec <= 0 {
		return StoryboardResult{}, errors.New("storyboard: unknown duration")
	}
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return StoryboardResult{}, err
	}
	interval := media.StoryboardInterval(durationSec)
	frames := media.StoryboardFrames(durationSec, interval)
	sheets := media.StoryboardSheets(frames)

	rctx, cancel := context.WithTimeout(ctx, storyboardTimeout(durationSec))
	defer cancel()
	var errTail tailBuffer
	cmd := exec.CommandContext(rctx, t.FFmpeg, media.BuildStoryboardArgs(in.Path, dir, interval, in.KeyframesOnly)...) // #nosec G204 -- operator-configured executable; argument builder permits local files only, no shell.
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
	if err := os.WriteFile(filepath.Join(dir, media.StoryboardVTT), []byte(media.BuildStoryboardVTT(durationSec, interval)), 0o600); err != nil {
		return StoryboardResult{}, err
	}
	return StoryboardResult{Frames: frames, Sheets: sheets, Interval: interval}, nil
}

// buildStoryboard runs the best-effort step of the pipeline. It returns the media-bucket key of
// storyboard.vtt, or "" when there is no storyboard: any failure is logged at warn (with the
// video id, which the logger carries) and the job goes on. Only a cancelled context (shutdown)
// is an error, so an interrupted job is given back like at any other step.
func (p *Pipeline) buildStoryboard(ctx context.Context, in StoryboardInput, outDir, prefix string, durationSec float64, logger *slog.Logger) (key string, took time.Duration, err error) {
	gen := p.Storyboard
	if gen == nil {
		gen = p.Tools.Storyboard
	}
	dir := filepath.Join(outDir, storyboardDir)
	start := time.Now()
	_, gerr := gen(ctx, in, dir, durationSec)
	took = time.Since(start)
	if ctx.Err() != nil {
		return "", took, ctx.Err()
	}
	if gerr != nil {
		logger.WarnContext(ctx, "storyboard failed; continuing without it", "error", gerr)
		_ = os.RemoveAll(dir)
		return "", took, nil
	}
	return StoryboardVTTKey(prefix), took, nil
}

// storyboardDir is the sub-directory of an attempt's output (and of its key prefix) that holds
// the sheets and the WebVTT track.
const storyboardDir = "storyboard"

// StoryboardKeyPrefix is the key prefix of the storyboard files of the attempt whose output lives
// under prefix (v/{video_id}/a{attempt}/). New videos (pipeline) and the backfill (V5a-b) both
// publish below it, so the layout is the same.
func StoryboardKeyPrefix(prefix string) string { return prefix + storyboardDir + "/" }

// StoryboardVTTKey is the media-bucket key of storyboard.vtt for the attempt under prefix.
func StoryboardVTTKey(prefix string) string { return StoryboardKeyPrefix(prefix) + media.StoryboardVTT }

// UploadStoryboard uploads every file of dir (sheet-NNN.jpg and storyboard.vtt, as Tools.Storyboard
// wrote them) to StoryboardKeyPrefix(prefix) with the Content-Type and Cache-Control the pipeline
// uses for them. The track goes last, so a half-uploaded storyboard never has a track that
// points at missing sheets. It returns the keys it uploaded (also on error, for cleanup).
func UploadStoryboard(ctx context.Context, objs Objects, bucket, prefix, dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var names []string
	for _, e := range entries {
		if !e.IsDir() && e.Name() != media.StoryboardVTT {
			names = append(names, e.Name())
		}
	}
	names = append(names, media.StoryboardVTT)
	var keys []string
	for _, name := range names {
		key := StoryboardKeyPrefix(prefix) + name
		keys = append(keys, key) // recorded before the call: a failed upload may still have left an object
		if err := objs.UploadFile(ctx, bucket, key, filepath.Join(dir, name), contentType(name), cacheControlValue); err != nil {
			return keys, &StorageError{Op: "upload " + name, Err: err}
		}
	}
	return keys, nil
}
