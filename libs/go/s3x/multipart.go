package s3x

import (
	"context"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// Part is one uploaded part of a multipart upload.
type Part struct {
	Number int32
	ETag   string
}

// CreateMultipart starts a multipart upload and returns its upload id.
func (c *Client) CreateMultipart(ctx context.Context, bucket, key, contentType string) (string, error) {
	in := &s3.CreateMultipartUploadInput{Bucket: &bucket, Key: &key}
	if contentType != "" {
		in.ContentType = &contentType
	}
	out, err := c.internal.CreateMultipartUpload(ctx, in)
	if err != nil {
		return "", mapErr("create multipart", err)
	}
	return aws.ToString(out.UploadId), nil
}

// PresignUploadPart returns a URL a client can PUT one part to, signed for the
// PUBLIC endpoint. It needs Config.PublicEndpoint (ErrNoPublicEndpoint otherwise).
// Nothing is sent to the server.
func (c *Client) PresignUploadPart(ctx context.Context, bucket, key, uploadID string, part int32, ttl time.Duration) (string, error) {
	if c.presign == nil {
		return "", ErrNoPublicEndpoint
	}
	out, err := c.presign.PresignUploadPart(ctx, &s3.UploadPartInput{
		Bucket: &bucket, Key: &key, UploadId: &uploadID, PartNumber: &part,
	}, s3.WithPresignExpires(ttl))
	if err != nil {
		return "", fmt.Errorf("s3x: presign part: %w", err)
	}
	return out.URL, nil
}

// CompleteMultipart assembles the parts, which must be in ascending part
// number order. Errors wrap ErrNoSuchUpload or ErrInvalidPart when the server
// says so.
func (c *Client) CompleteMultipart(ctx context.Context, bucket, key, uploadID string, parts []Part) error {
	cp := make([]types.CompletedPart, len(parts))
	for i, p := range parts {
		cp[i] = types.CompletedPart{PartNumber: aws.Int32(p.Number), ETag: aws.String(p.ETag)}
	}
	_, err := c.internal.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{
		Bucket: &bucket, Key: &key, UploadId: &uploadID,
		MultipartUpload: &types.CompletedMultipartUpload{Parts: cp},
	})
	return mapErr("complete multipart", err)
}

// AbortMultipart cancels a multipart upload; an unknown upload id wraps ErrNoSuchUpload.
func (c *Client) AbortMultipart(ctx context.Context, bucket, key, uploadID string) error {
	_, err := c.internal.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{
		Bucket: &bucket, Key: &key, UploadId: &uploadID,
	})
	return mapErr("abort multipart", err)
}
