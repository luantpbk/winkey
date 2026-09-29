// Package s3x is Winkey's shared S3 client for Garage and any S3-compatible
// store (ADR-004): path-style addressing, no bucket notifications or
// versioning, and only the basic operation set (Put/Get/Head/Delete/List,
// multipart, presigned URLs).
//
// Two endpoints are used on purpose:
//
//   - Endpoint is the internal one and serves every server-side call;
//   - PublicEndpoint (e.g. https://s3.winkey.vn) is used ONLY to presign URLs
//     handed to browsers. A presigned signature is bound to the host, so
//     presigning with the internal endpoint produces URLs that do not work.
//     Services that never presign (the transcoder) leave it empty and
//     PresignUploadPart then returns ErrNoPublicEndpoint instead of silently
//     signing for the wrong host.
//
// Request checksums are computed only when an operation requires them
// (RequestChecksumCalculation = WhenRequired). The SDK default adds and signs
// x-amz-checksum-* parameters that a browser doing a plain PUT would not send,
// and Garage does not need them.
package s3x

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/feature/s3/manager"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// DefaultRegion is the region Garage is configured with (S3_REGION=garage).
const DefaultRegion = "garage"

// Config selects the endpoints and credentials.
type Config struct {
	Endpoint        string // internal endpoint for server-side calls (required)
	PublicEndpoint  string // endpoint used only to presign URLs for clients (optional)
	Region          string // default DefaultRegion
	AccessKeyID     string
	SecretAccessKey string
}

// Validate checks the endpoints are absolute http(s) URLs and the credentials
// are present. Errors never contain the secret.
func (c Config) Validate() error {
	var errs []error
	if err := checkEndpoint("Endpoint", c.Endpoint, true); err != nil {
		errs = append(errs, err)
	}
	if err := checkEndpoint("PublicEndpoint", c.PublicEndpoint, false); err != nil {
		errs = append(errs, err)
	}
	if c.AccessKeyID == "" || c.SecretAccessKey == "" {
		errs = append(errs, errors.New("s3x: AccessKeyID and SecretAccessKey are required"))
	}
	return errors.Join(errs...)
}

func checkEndpoint(name, raw string, required bool) error {
	if raw == "" {
		if required {
			return fmt.Errorf("s3x: %s is required", name)
		}
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("s3x: %s must be an absolute http(s) URL", name)
	}
	return nil
}

// Client is safe for concurrent use.
type Client struct {
	cfg        Config
	internal   *s3.Client
	presign    *s3.PresignClient // nil without PublicEndpoint
	downloader *manager.Downloader
}

// New validates cfg and builds the client(s). It performs no network call.
func New(cfg Config) (*Client, error) {
	if cfg.Region == "" {
		cfg.Region = DefaultRegion
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	mk := func(endpoint string) *s3.Client {
		return s3.New(s3.Options{
			Region:                     cfg.Region,
			BaseEndpoint:               aws.String(endpoint),
			UsePathStyle:               true,
			Credentials:                credentials.NewStaticCredentialsProvider(cfg.AccessKeyID, cfg.SecretAccessKey, ""),
			RequestChecksumCalculation: aws.RequestChecksumCalculationWhenRequired,
			ResponseChecksumValidation: aws.ResponseChecksumValidationWhenRequired,
		})
	}
	c := &Client{cfg: cfg, internal: mk(cfg.Endpoint)}
	if cfg.PublicEndpoint != "" {
		c.presign = s3.NewPresignClient(mk(cfg.PublicEndpoint))
	}
	c.downloader = manager.NewDownloader(c.internal, func(d *manager.Downloader) {
		d.PartSize = 16 << 20
		d.Concurrency = 8
	})
	return c, nil
}

// SDK returns the underlying internal-endpoint SDK client for operations s3x
// does not wrap (tests, one-offs). Prefer adding a method here.
func (c *Client) SDK() *s3.Client { return c.internal }

// ObjectInfo is what Head returns.
type ObjectInfo struct {
	Size        int64
	ETag        string
	ContentType string
}

// Ping checks that the bucket is reachable (readiness probes).
func (c *Client) Ping(ctx context.Context, bucket string) error {
	_, err := c.internal.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: &bucket})
	return mapErr("head bucket", err)
}

// Head returns the object's metadata, or an error wrapping ErrNotFound.
func (c *Client) Head(ctx context.Context, bucket, key string) (ObjectInfo, error) {
	out, err := c.internal.HeadObject(ctx, &s3.HeadObjectInput{Bucket: &bucket, Key: &key})
	if err != nil {
		return ObjectInfo{}, mapErr("head object", err)
	}
	return ObjectInfo{Size: aws.ToInt64(out.ContentLength), ETag: aws.ToString(out.ETag), ContentType: aws.ToString(out.ContentType)}, nil
}

// Delete removes one object. Deleting a missing object is not an error (S3 semantics).
func (c *Client) Delete(ctx context.Context, bucket, key string) error {
	_, err := c.internal.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: &bucket, Key: &key})
	return mapErr("delete object", err)
}

// DeletePrefix removes every object whose key starts with prefix. The prefix
// must be non-empty and end in "/" so a typo can never wipe a bucket or a
// sibling ("v/abc" would also match "v/abcd/..."). Bulk deletes are preferred;
// if the server rejects one (checksum/compat quirks) that batch falls back to
// one request per object.
func (c *Client) DeletePrefix(ctx context.Context, bucket, prefix string) error {
	if prefix == "" || !strings.HasSuffix(prefix, "/") {
		return fmt.Errorf("s3x: refusing to delete prefix %q: it must be non-empty and end with '/'", prefix)
	}
	p := s3.NewListObjectsV2Paginator(c.internal, &s3.ListObjectsV2Input{Bucket: &bucket, Prefix: &prefix})
	for p.HasMorePages() {
		page, err := p.NextPage(ctx)
		if err != nil {
			return mapErr("list objects", err)
		}
		if len(page.Contents) == 0 {
			continue
		}
		ids := make([]types.ObjectIdentifier, len(page.Contents))
		for i, o := range page.Contents {
			ids[i] = types.ObjectIdentifier{Key: o.Key}
		}
		out, err := c.internal.DeleteObjects(ctx, &s3.DeleteObjectsInput{
			Bucket: &bucket, Delete: &types.Delete{Objects: ids, Quiet: aws.Bool(true)},
		})
		if err == nil && len(out.Errors) == 0 {
			continue
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		for _, id := range ids {
			if err := c.Delete(ctx, bucket, aws.ToString(id.Key)); err != nil {
				return err
			}
		}
	}
	return nil
}

// ListPrefixes lists the immediate "sub-directories" under prefix (S3 common
// prefixes with delimiter "/"), each ending in "/".
func (c *Client) ListPrefixes(ctx context.Context, bucket, prefix string) ([]string, error) {
	var out []string
	delim := "/"
	p := s3.NewListObjectsV2Paginator(c.internal, &s3.ListObjectsV2Input{Bucket: &bucket, Prefix: &prefix, Delimiter: &delim})
	for p.HasMorePages() {
		page, err := p.NextPage(ctx)
		if err != nil {
			return nil, mapErr("list prefixes", err)
		}
		for _, cp := range page.CommonPrefixes {
			out = append(out, aws.ToString(cp.Prefix))
		}
	}
	return out, nil
}

// MaxPutSize is the largest file UploadFile sends in one request (S3 limit).
const MaxPutSize = 5 << 30

// PutOptions are the headers stored with an uploaded object.
type PutOptions struct {
	ContentType  string
	CacheControl string
}

// UploadFile uploads a local file with a single PutObject (files up to
// MaxPutSize; larger sources belong in a multipart upload).
func (c *Client) UploadFile(ctx context.Context, bucket, key, srcPath string, opt PutOptions) error {
	f, err := os.Open(srcPath)
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	if st.Size() > MaxPutSize {
		return fmt.Errorf("s3x: %s is %d bytes, above the single-request limit of %d", srcPath, st.Size(), int64(MaxPutSize))
	}
	in := &s3.PutObjectInput{Bucket: &bucket, Key: &key, Body: f, ContentLength: aws.Int64(st.Size())}
	if opt.ContentType != "" {
		in.ContentType = &opt.ContentType
	}
	if opt.CacheControl != "" {
		in.CacheControl = &opt.CacheControl
	}
	_, err = c.internal.PutObject(ctx, in)
	return mapErr("put object", err)
}

// Download fetches an object into dstPath with parallel ranged requests
// (8 x 16 MiB), and removes the partial file on failure.
func (c *Client) Download(ctx context.Context, bucket, key, dstPath string) error {
	f, err := os.Create(dstPath)
	if err != nil {
		return err
	}
	_, err = c.downloader.Download(ctx, f, &s3.GetObjectInput{Bucket: &bucket, Key: &key})
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(dstPath)
		return mapErr("download", err)
	}
	return nil
}
