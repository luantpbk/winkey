package job

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/luantpbk/winkey/services/transcoder/internal/media"
)

// Tools runs ffmpeg and ffprobe from configured paths (FFMPEG_PATH /
// FFPROBE_PATH), so the worker is portable across Linux and Windows.
type Tools struct {
	FFmpeg  string
	FFprobe string
}

const stderrTailBytes = 4096

// tailBuffer keeps the last stderrTailBytes written to it.
type tailBuffer struct{ buf []byte }

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.buf = append(t.buf, p...)
	if len(t.buf) > stderrTailBytes {
		t.buf = t.buf[len(t.buf)-stderrTailBytes:]
	}
	return len(p), nil
}
func (t *tailBuffer) String() string { return strings.TrimSpace(string(t.buf)) }

// Probe runs ffprobe on a local file. A file ffprobe cannot read is
// INVALID_INPUT (retrying will not fix it).
func (t Tools) Probe(ctx context.Context, path string) (media.Info, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	var out bytes.Buffer
	var errTail tailBuffer
	cmd := exec.CommandContext(ctx, t.FFprobe, media.BuildProbeArgs(path)...)
	cmd.Stdout, cmd.Stderr = &out, &errTail
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return media.Info{}, ctx.Err()
		}
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return media.Info{}, &media.InvalidInputError{Msg: "the file is not a readable video"}
		}
		return media.Info{}, &EncoderError{Op: "ffprobe", Err: err, Tail: errTail.String()}
	}
	return media.ParseProbe(out.Bytes())
}

// EncodeTimeout is the time budget of one ffmpeg run: max(10m, 3×duration).
func EncodeTimeout(durationSec float64) time.Duration {
	d := time.Duration(3 * durationSec * float64(time.Second))
	return max(10*time.Minute, d)
}

// RunHLS runs the single ffmpeg process producing every rendition into
// plan.OutDir, reporting progress (0..100) as it goes.
func (t Tools) RunHLS(ctx context.Context, plan media.HLSPlan, durationSec float64, onProgress func(float64)) error {
	for _, r := range plan.Renditions {
		if err := os.MkdirAll(filepath.Join(plan.OutDir, r.Name), 0o755); err != nil {
			return fmt.Errorf("create output dir: %w", err)
		}
	}
	budget := EncodeTimeout(durationSec)
	rctx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()

	cmd := exec.CommandContext(rctx, t.FFmpeg, media.BuildHLSArgs(plan)...)
	// ffmpeg's HLS muxer fails with "Permission denied" on Windows when its
	// working directory is on a different drive than the output. Run it in the
	// output directory so the worker does not depend on where it was started.
	cmd.Dir = plan.OutDir
	var errTail tailBuffer
	cmd.Stderr = &errTail
	cmd.WaitDelay = 10 * time.Second
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return &EncoderError{Op: "ffmpeg start", Err: err}
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		media.ReadProgress(stdout, int64(durationSec*1e6), onProgress)
		_, _ = io.Copy(io.Discard, stdout)
	}()
	err = cmd.Wait()
	<-done
	if err == nil {
		return nil
	}
	if ctx.Err() != nil { // shutdown, not a timeout
		return ctx.Err()
	}
	if errors.Is(rctx.Err(), context.DeadlineExceeded) {
		return &TimeoutError{After: budget.String()}
	}
	return &EncoderError{Op: "ffmpeg", Err: err, Tail: errTail.String()}
}

// Thumbnail writes a poster JPEG taken at atSec.
func (t Tools) Thumbnail(ctx context.Context, input, output string, atSec float64) error {
	if err := os.MkdirAll(filepath.Dir(output), 0o755); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	var errTail tailBuffer
	cmd := exec.CommandContext(ctx, t.FFmpeg, media.BuildThumbnailArgs(input, output, atSec)...)
	cmd.Stderr = &errTail
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return &EncoderError{Op: "ffmpeg thumbnail", Err: err, Tail: errTail.String()}
	}
	if st, err := os.Stat(output); err != nil || st.Size() == 0 {
		return &EncoderError{Op: "ffmpeg thumbnail", Err: errors.New("no output produced")}
	}
	return nil
}

// ResolveEncoder turns the ENCODER setting into "nvenc" or "x264". For "auto"
// it runs a one-frame test encode with h264_nvenc.
func (t Tools) ResolveEncoder(ctx context.Context, setting string) (string, error) {
	switch strings.ToLower(setting) {
	case "nvenc":
		return media.EncoderNVENC, nil
	case "x264":
		return media.EncoderX264, nil
	case "auto", "":
		ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		if err := exec.CommandContext(ctx, t.FFmpeg, media.BuildEncoderProbeArgs()...).Run(); err == nil {
			return media.EncoderNVENC, nil
		}
		return media.EncoderX264, nil
	}
	return "", fmt.Errorf("ENCODER must be auto, nvenc or x264, got %q", setting)
}
