// Package objects adapts the shared S3 client (libs/go/s3x) to job.Objects:
// path-style Garage access, no bucket notifications or versioning (ADR-004).
package objects

import (
	"context"

	"github.com/luantpbk/winkey/libs/go/s3x"
	"github.com/luantpbk/winkey/services/transcoder/internal/job"
)

// S3 implements job.Objects on an s3x.Client. The transcoder only makes
// server-side calls, so the client needs no PublicEndpoint.
type S3 struct{ c *s3x.Client }

var _ job.Objects = (*S3)(nil)

// New wraps the client.
func New(c *s3x.Client) *S3 { return &S3{c: c} }

// Ping checks that a bucket is reachable (readiness).
func (s *S3) Ping(ctx context.Context, bucket string) error { return s.c.Ping(ctx, bucket) }

func (s *S3) Download(ctx context.Context, bucket, key, dst string) error {
	return s.c.Download(ctx, bucket, key, dst)
}

func (s *S3) UploadFile(ctx context.Context, bucket, key, src, contentType, cacheControl string) error {
	return s.c.UploadFile(ctx, bucket, key, src, s3x.PutOptions{ContentType: contentType, CacheControl: cacheControl})
}

func (s *S3) DeleteObject(ctx context.Context, bucket, key string) error {
	return s.c.Delete(ctx, bucket, key)
}

func (s *S3) DeletePrefix(ctx context.Context, bucket, prefix string) error {
	return s.c.DeletePrefix(ctx, bucket, prefix)
}

func (s *S3) ListPrefixes(ctx context.Context, bucket, prefix string) ([]string, error) {
	return s.c.ListPrefixes(ctx, bucket, prefix)
}
