// Package objects adapts the shared S3 client (libs/go/s3x) to domain.Objects: the media bucket,
// where video-svc only writes and deletes subtitle files (task V5b).
package objects

import (
	"context"

	"github.com/luantpbk/winkey/libs/go/s3x"
	"github.com/luantpbk/winkey/services/video/internal/domain"
)

// S3 implements domain.Objects on an s3x.Client (server-side calls only: no PublicEndpoint).
type S3 struct{ c *s3x.Client }

var _ domain.Objects = (*S3)(nil)

// New wraps the client.
func New(c *s3x.Client) *S3 { return &S3{c: c} }

func (s *S3) Put(ctx context.Context, bucket, key string, data []byte, contentType, cacheControl string) error {
	return s.c.PutBytes(ctx, bucket, key, data, s3x.PutOptions{ContentType: contentType, CacheControl: cacheControl})
}

func (s *S3) Delete(ctx context.Context, bucket, key string) error {
	return s.c.Delete(ctx, bucket, key)
}
