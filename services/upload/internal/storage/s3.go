// Package storage adapts the shared S3 client (libs/go/s3x) to domain.Storage.
//
// The two-endpoint rule lives in s3x: server-side calls use the internal
// endpoint, presigning uses the public one only (the signature is bound to the
// host).
package storage

import (
	"context"
	"time"

	"github.com/luantpbk/winkey/libs/go/s3x"
	"github.com/luantpbk/winkey/services/upload/internal/domain"
)

// S3 implements domain.Storage on an s3x.Client.
type S3 struct{ c *s3x.Client }

var _ domain.Storage = (*S3)(nil)

// New wraps the client. It must have been built with a PublicEndpoint, or
// PresignPart fails with s3x.ErrNoPublicEndpoint.
func New(c *s3x.Client) *S3 { return &S3{c: c} }

func (s *S3) CreateMultipart(ctx context.Context, bucket, key, contentType string) (string, error) {
	return s.c.CreateMultipart(ctx, bucket, key, contentType)
}

func (s *S3) PresignPart(ctx context.Context, bucket, key, uploadID string, part int32, ttl time.Duration) (string, error) {
	return s.c.PresignUploadPart(ctx, bucket, key, uploadID, part, ttl)
}

func (s *S3) CompleteMultipart(ctx context.Context, bucket, key, uploadID string, parts []domain.Part) error {
	ps := make([]s3x.Part, len(parts))
	for i, p := range parts {
		ps[i] = s3x.Part{Number: p.Number, ETag: p.ETag}
	}
	return s.c.CompleteMultipart(ctx, bucket, key, uploadID, ps)
}

func (s *S3) AbortMultipart(ctx context.Context, bucket, key, uploadID string) error {
	return s.c.AbortMultipart(ctx, bucket, key, uploadID)
}

func (s *S3) HeadSize(ctx context.Context, bucket, key string) (int64, error) {
	info, err := s.c.Head(ctx, bucket, key)
	return info.Size, err
}

func (s *S3) DeleteObject(ctx context.Context, bucket, key string) error {
	return s.c.Delete(ctx, bucket, key)
}

func (s *S3) Ping(ctx context.Context, bucket string) error { return s.c.Ping(ctx, bucket) }
