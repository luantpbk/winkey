// Package storage implements domain.Storage on an S3-compatible service
// (Garage). Two clients are used because a presigned signature is bound to the
// host: server-side calls go to the internal endpoint, presigning uses the
// public one (ADR-004). Both use path-style addressing.
package storage

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"

	"github.com/luantpbk/winkey/services/upload/internal/domain"
)

// Config selects the endpoints and credentials.
type Config struct {
	Endpoint       string // internal, server-side calls
	PublicEndpoint string // used only for presigning
	Region         string
	AccessKeyID    string
	SecretKey      string
}

// S3 implements domain.Storage.
type S3 struct {
	client  *s3.Client
	presign *s3.PresignClient
}

// New builds the two clients.
func New(c Config) *S3 {
	mk := func(endpoint string) *s3.Client {
		return s3.New(s3.Options{
			Region:       c.Region,
			BaseEndpoint: aws.String(endpoint),
			UsePathStyle: true,
			Credentials:  credentials.NewStaticCredentialsProvider(c.AccessKeyID, c.SecretKey, ""),
			// Browsers upload parts without SDK-computed checksum headers, so the
			// SDK must not add (and sign) them; Garage does not need them either.
			RequestChecksumCalculation: aws.RequestChecksumCalculationWhenRequired,
			ResponseChecksumValidation: aws.ResponseChecksumValidationWhenRequired,
		})
	}
	return &S3{client: mk(c.Endpoint), presign: s3.NewPresignClient(mk(c.PublicEndpoint))}
}

func (s *S3) CreateMultipart(ctx context.Context, bucket, key, contentType string) (string, error) {
	out, err := s.client.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{
		Bucket: &bucket, Key: &key, ContentType: &contentType,
	})
	if err != nil {
		return "", fmt.Errorf("create multipart: %w", err)
	}
	return aws.ToString(out.UploadId), nil
}

func (s *S3) PresignPart(ctx context.Context, bucket, key, uploadID string, part int32, ttl time.Duration) (string, error) {
	out, err := s.presign.PresignUploadPart(ctx, &s3.UploadPartInput{
		Bucket: &bucket, Key: &key, UploadId: &uploadID, PartNumber: &part,
	}, s3.WithPresignExpires(ttl))
	if err != nil {
		return "", fmt.Errorf("presign part: %w", err)
	}
	return out.URL, nil
}

func (s *S3) CompleteMultipart(ctx context.Context, bucket, key, uploadID string, parts []domain.Part) error {
	cp := make([]types.CompletedPart, len(parts))
	for i, p := range parts {
		cp[i] = types.CompletedPart{PartNumber: aws.Int32(p.Number), ETag: aws.String(p.ETag)}
	}
	_, err := s.client.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{
		Bucket: &bucket, Key: &key, UploadId: &uploadID,
		MultipartUpload: &types.CompletedMultipartUpload{Parts: cp},
	})
	return mapErr("complete multipart", err)
}

func (s *S3) AbortMultipart(ctx context.Context, bucket, key, uploadID string) error {
	_, err := s.client.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{
		Bucket: &bucket, Key: &key, UploadId: &uploadID,
	})
	return mapErr("abort multipart", err)
}

func (s *S3) HeadSize(ctx context.Context, bucket, key string) (int64, error) {
	out, err := s.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: &bucket, Key: &key})
	if err != nil {
		return 0, mapErr("head object", err)
	}
	return aws.ToInt64(out.ContentLength), nil
}

func (s *S3) DeleteObject(ctx context.Context, bucket, key string) error {
	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: &bucket, Key: &key})
	return mapErr("delete object", err)
}

func (s *S3) Ping(ctx context.Context, bucket string) error {
	_, err := s.client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: &bucket})
	return err
}

// mapErr translates S3 error codes into the domain errors callers branch on.
func mapErr(op string, err error) error {
	if err == nil {
		return nil
	}
	var nsu *types.NoSuchUpload
	var nsk *types.NoSuchKey
	var nf *types.NotFound
	var ae smithy.APIError
	switch {
	case errors.As(err, &nsu):
		return fmt.Errorf("%s: %w", op, domain.ErrNoSuchUpload)
	case errors.As(err, &nsk), errors.As(err, &nf):
		return fmt.Errorf("%s: %w", op, domain.ErrNoSuchObject)
	case errors.As(err, &ae):
		switch ae.ErrorCode() {
		case "NoSuchUpload":
			return fmt.Errorf("%s: %w", op, domain.ErrNoSuchUpload)
		case "InvalidPart", "InvalidPartOrder", "EntityTooSmall":
			return fmt.Errorf("%s: %w: %s", op, domain.ErrInvalidPart, ae.ErrorCode())
		case "NoSuchKey", "NotFound":
			return fmt.Errorf("%s: %w", op, domain.ErrNoSuchObject)
		}
	}
	return fmt.Errorf("%s: %w", op, err)
}
