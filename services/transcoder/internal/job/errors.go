// Package job implements the per-message transcoding pipeline.
package job

import (
	"context"
	"errors"
	"fmt"

	"github.com/luantpbk/winkey/services/transcoder/internal/media"
)

// Failure reasons: the enum of contracts/events/video.failed.schema.json.
const (
	ReasonInvalidInput = "INVALID_INPUT"
	ReasonTimeout      = "TIMEOUT"
	ReasonEncoder      = "ENCODER_ERROR"
	ReasonStorage      = "STORAGE_ERROR"
	ReasonInternal     = "INTERNAL"
)

// TimeoutError: ffmpeg exceeded its time budget.
type TimeoutError struct{ After string }

func (e *TimeoutError) Error() string { return "ffmpeg timed out after " + e.After }

// EncoderError: ffmpeg/ffprobe failed. Tail holds the last stderr lines for
// operators (logged, never shown to the owner).
type EncoderError struct {
	Op   string
	Tail string
	Err  error
}

func (e *EncoderError) Error() string {
	return fmt.Sprintf("%s failed: %v: %s", e.Op, e.Err, e.Tail)
}
func (e *EncoderError) Unwrap() error { return e.Err }

// StorageError wraps an object-storage failure.
type StorageError struct {
	Op  string
	Err error
}

func (e *StorageError) Error() string { return "storage " + e.Op + ": " + e.Err.Error() }
func (e *StorageError) Unwrap() error { return e.Err }

// Failure is the classified outcome of a failed job.
type Failure struct {
	Reason    string
	Retryable bool
	// Message is safe to show to the owner: no paths, no stderr, no stack.
	Message string
}

// ErrInterrupted is returned when the worker is shutting down; the message is
// Nak'd without counting as a failure of the video.
var ErrInterrupted = errors.New("interrupted by shutdown")

// Classify maps an error from the pipeline to a Failure.
//
//	InvalidInputError → INVALID_INPUT (never retried)
//	TimeoutError      → TIMEOUT       (retried)
//	EncoderError      → ENCODER_ERROR (retried: NVENC/GPU trouble is transient)
//	StorageError      → STORAGE_ERROR (retried)
//	anything else     → INTERNAL      (retried)
func Classify(err error) Failure {
	var ii *media.InvalidInputError
	var to *TimeoutError
	var ee *EncoderError
	var se *StorageError
	switch {
	case errors.As(err, &ii):
		return Failure{ReasonInvalidInput, false, "The file could not be processed: " + ii.Msg + "."}
	case errors.As(err, &to), errors.Is(err, context.DeadlineExceeded):
		return Failure{ReasonTimeout, true, "Processing took too long."}
	case errors.As(err, &ee):
		return Failure{ReasonEncoder, true, "The video could not be encoded."}
	case errors.As(err, &se):
		return Failure{ReasonStorage, true, "A storage error occurred while processing the video."}
	default:
		return Failure{ReasonInternal, true, "An internal error occurred while processing the video."}
	}
}
