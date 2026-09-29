// Package objects implements job.Objects on an S3-compatible store (Garage):
// path-style addressing, no bucket notifications or versioning (ADR-004).
package objects

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/feature/s3/manager"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"

	"github.com/luantpbk/winkey/services/transcoder/internal/job"
)

// Config selects the endpoint and credentials.
type Config struct {
	Endpoint    string
	Region      string
	AccessKeyID string
	SecretKey   string
}

// S3 implements job.Objects.
type S3 struct {
	client     *s3.Client
	downloader *manager.Downloader
}

var _ job.Objects = (*S3)(nil)

// New builds the client. Checksums are only sent when an operation requires
// them, which keeps uploads compatible with Garage.
func New(c Config) *S3 {
	cl := s3.New(s3.Options{
		Region:                     c.Region,
		BaseEndpoint:               aws.String(c.Endpoint),
		UsePathStyle:               true,
		Credentials:                credentials.NewStaticCredentialsProvider(c.AccessKeyID, c.SecretKey, ""),
		RequestChecksumCalculation: aws.RequestChecksumCalculationWhenRequired,
		ResponseChecksumValidation: aws.ResponseChecksumValidationWhenRequired,
	})
	return &S3{client: cl, downloader: manager.NewDownloader(cl, func(d *manager.Downloader) {
		d.PartSize = 16 << 20
		d.Concurrency = 8
	})}
}

// Client exposes the SDK client (used by health checks).
func (s *S3) Client() *s3.Client { return s.client }

// Ping checks that a bucket is reachable.
func (s *S3) Ping(ctx context.Context, bucket string) error {
	_, err := s.client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: &bucket})
	return err
}

func (s *S3) Download(ctx context.Context, bucket, key, dst string) error {
	f, err := os.Create(dst)
	if err != nil {
		return err
	}
	_, err = s.downloader.Download(ctx, f, &s3.GetObjectInput{Bucket: &bucket, Key: &key})
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(dst)
		return err
	}
	return nil
}

func (s *S3) UploadFile(ctx context.Context, bucket, key, src, contentType, cacheControl string) error {
	f, err := os.Open(src)
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	_, err = s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: &bucket, Key: &key, Body: f, ContentLength: aws.Int64(st.Size()),
		ContentType: &contentType, CacheControl: &cacheControl,
	})
	return err
}

func (s *S3) DeleteObject(ctx context.Context, bucket, key string) error {
	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: &bucket, Key: &key})
	return err
}

// DeletePrefix lists and deletes every object under prefix. Bulk deletes are
// preferred; if the server rejects them (checksum/compat quirks) it falls
// back to one request per object.
func (s *S3) DeletePrefix(ctx context.Context, bucket, prefix string) error {
	if prefix == "" || !strings.HasSuffix(prefix, "/") {
		return fmt.Errorf("refusing to delete prefix %q: must be non-empty and end with '/'", prefix)
	}
	p := s3.NewListObjectsV2Paginator(s.client, &s3.ListObjectsV2Input{Bucket: &bucket, Prefix: &prefix})
	for p.HasMorePages() {
		page, err := p.NextPage(ctx)
		if err != nil {
			return err
		}
		if len(page.Contents) == 0 {
			continue
		}
		ids := make([]types.ObjectIdentifier, len(page.Contents))
		for i, o := range page.Contents {
			ids[i] = types.ObjectIdentifier{Key: o.Key}
		}
		out, err := s.client.DeleteObjects(ctx, &s3.DeleteObjectsInput{
			Bucket: &bucket, Delete: &types.Delete{Objects: ids, Quiet: aws.Bool(true)},
		})
		if err == nil && len(out.Errors) == 0 {
			continue
		}
		for _, id := range ids {
			if err := s.DeleteObject(ctx, bucket, aws.ToString(id.Key)); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *S3) ListPrefixes(ctx context.Context, bucket, prefix string) ([]string, error) {
	var out []string
	delim := "/"
	p := s3.NewListObjectsV2Paginator(s.client, &s3.ListObjectsV2Input{Bucket: &bucket, Prefix: &prefix, Delimiter: &delim})
	for p.HasMorePages() {
		page, err := p.NextPage(ctx)
		if err != nil {
			return nil, err
		}
		for _, cp := range page.CommonPrefixes {
			out = append(out, aws.ToString(cp.Prefix))
		}
	}
	return out, nil
}
