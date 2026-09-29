package job

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/luantpbk/winkey/services/transcoder/internal/media"
)

func TestClassify(t *testing.T) {
	tests := []struct {
		name      string
		err       error
		reason    string
		retryable bool
	}{
		{"invalid input", &media.InvalidInputError{Msg: "no video stream"}, ReasonInvalidInput, false},
		{"wrapped invalid input", fmt.Errorf("probe: %w", &media.InvalidInputError{Msg: "x"}), ReasonInvalidInput, false},
		{"ffmpeg timeout", &TimeoutError{After: "10m"}, ReasonTimeout, true},
		{"context deadline", context.DeadlineExceeded, ReasonTimeout, true},
		{"encoder", &EncoderError{Op: "ffmpeg", Err: errors.New("exit status 1"), Tail: "boom"}, ReasonEncoder, true},
		{"storage", &StorageError{Op: "upload", Err: errors.New("503")}, ReasonStorage, true},
		{"wrapped storage", fmt.Errorf("x: %w", &StorageError{Op: "download", Err: errors.New("eof")}), ReasonStorage, true},
		{"database", errors.New("connection refused"), ReasonInternal, true},
	}
	for _, tc := range tests {
		f := Classify(tc.err)
		if f.Reason != tc.reason || f.Retryable != tc.retryable || f.Message == "" {
			t.Errorf("%s: %+v", tc.name, f)
		}
	}
}

func TestClassifyMessagesAreOwnerSafe(t *testing.T) {
	secret := "/scratch/0192/source postgres://u:pw@host"
	for _, err := range []error{
		&EncoderError{Op: "ffmpeg", Err: errors.New(secret), Tail: secret},
		&StorageError{Op: "upload", Err: errors.New(secret)},
		errors.New(secret),
	} {
		if m := Classify(err).Message; strings.Contains(m, "scratch") || strings.Contains(m, "postgres") || strings.Contains(m, "pw") {
			t.Errorf("owner message leaks internals: %q", m)
		}
	}
}

func TestReasonsMatchContract(t *testing.T) {
	// video.failed.schema.json: enum INVALID_INPUT, TIMEOUT, ENCODER_ERROR, STORAGE_ERROR, INTERNAL
	want := map[string]bool{"INVALID_INPUT": true, "TIMEOUT": true, "ENCODER_ERROR": true, "STORAGE_ERROR": true, "INTERNAL": true}
	for _, r := range []string{ReasonInvalidInput, ReasonTimeout, ReasonEncoder, ReasonStorage, ReasonInternal} {
		if !want[r] {
			t.Errorf("reason %q not in contract", r)
		}
	}
}
