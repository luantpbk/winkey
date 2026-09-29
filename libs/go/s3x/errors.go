package s3x

import (
	"errors"
	"fmt"
	"strings"

	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
)

// Sentinel errors; use errors.Is. Operation errors wrap them together with the
// operation name and, for unmapped failures, the SDK error.
var (
	// ErrNotFound: the object (or bucket) does not exist.
	ErrNotFound = errors.New("s3x: not found")
	// ErrNoSuchUpload: the multipart upload id is unknown (aborted or completed).
	ErrNoSuchUpload = errors.New("s3x: no such multipart upload")
	// ErrInvalidPart: a part is missing, out of order, too small, or its ETag does not match.
	ErrInvalidPart = errors.New("s3x: invalid multipart part")
	// ErrNoPublicEndpoint: presigning was requested but Config.PublicEndpoint is empty.
	ErrNoPublicEndpoint = errors.New("s3x: PublicEndpoint is not configured, refusing to presign for the internal host")
)

// mapErr translates S3 error codes into the sentinel errors. Other errors are
// wrapped with the operation name and keep the SDK error in the chain.
func mapErr(op string, err error) error {
	if err == nil {
		return nil
	}
	var nsu *types.NoSuchUpload
	var nsk *types.NoSuchKey
	var nf *types.NotFound
	var nsb *types.NoSuchBucket
	var ae smithy.APIError
	switch {
	case errors.As(err, &nsu):
		return fmt.Errorf("%s: %w", op, ErrNoSuchUpload)
	case errors.As(err, &nsk), errors.As(err, &nf), errors.As(err, &nsb):
		return fmt.Errorf("%s: %w", op, ErrNotFound)
	case errors.As(err, &ae):
		switch ae.ErrorCode() {
		case "NoSuchUpload":
			return fmt.Errorf("%s: %w", op, ErrNoSuchUpload)
		case "InvalidPart", "InvalidPartOrder", "EntityTooSmall":
			return fmt.Errorf("%s: %w: %s", op, ErrInvalidPart, ae.ErrorCode())
		case "InvalidRequest":
			// Garage answers a complete for an upload that received no parts with a
			// generic InvalidRequest ("No data was uploaded"). For the caller that is an
			// invalid part list, not a server fault.
			if strings.Contains(ae.ErrorMessage(), "No data was uploaded") {
				return fmt.Errorf("%s: %w: %s", op, ErrInvalidPart, ae.ErrorMessage())
			}
		case "NoSuchKey", "NotFound", "NoSuchBucket":
			return fmt.Errorf("%s: %w", op, ErrNotFound)
		}
	}
	return fmt.Errorf("%s: %w", op, err)
}
