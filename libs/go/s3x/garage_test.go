package s3x_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"github.com/luantpbk/winkey/libs/go/s3x"
	"github.com/luantpbk/winkey/libs/go/testkit"
)

// These tests run against a real single-node Garage (testkit; they skip
// without Docker, CI runs them with WINKEY_REQUIRE_DOCKER=1). The unit tests
// use a protocol-level fake; this file checks the same behaviour on Garage,
// including the parts a fake cannot vouch for (presigned PUT accepted by
// Garage, error codes, DeleteObjects at scale).

func garageClient(t *testing.T) (*s3x.Client, *testkit.Garage) {
	t.Helper()
	g := testkit.StartGarage(t)
	// The test reaches Garage on one address, so it doubles as the public endpoint.
	c, err := s3x.New(s3x.Config{Endpoint: g.Endpoint, PublicEndpoint: g.Endpoint, Region: g.Region, AccessKeyID: g.AccessKey, SecretAccessKey: g.SecretKey})
	if err != nil {
		t.Fatal(err)
	}
	return c, g
}

func TestGarageMultipartWithPresignedParts(t *testing.T) {
	c, _ := garageClient(t)
	ctx := context.Background()
	key := "owner/video/source"

	id, err := c.CreateMultipart(ctx, testkit.RawBucket, key, "video/mp4")
	if err != nil {
		t.Fatal(err)
	}
	// Two parts: the first must be >= 5 MiB (S3 minimum), the last may be small.
	sizes := []int{5 << 20, 1 << 20}
	var parts []s3x.Part
	var whole []byte
	for i, n := range sizes {
		buf := make([]byte, n)
		_, _ = rand.Read(buf)
		whole = append(whole, buf...)
		u, err := c.PresignUploadPart(ctx, testkit.RawBucket, key, id, int32(i+1), time.Hour)
		if err != nil {
			t.Fatal(err)
		}
		req, _ := http.NewRequest(http.MethodPut, u, bytes.NewReader(buf)) // exactly what a browser sends
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 || resp.Header.Get("ETag") == "" {
			t.Fatalf("part %d: %d etag=%q", i+1, resp.StatusCode, resp.Header.Get("ETag"))
		}
		parts = append(parts, s3x.Part{Number: int32(i + 1), ETag: resp.Header.Get("ETag")})
	}
	if err := c.CompleteMultipart(ctx, testkit.RawBucket, key, id, parts); err != nil {
		t.Fatal(err)
	}
	info, err := c.Head(ctx, testkit.RawBucket, key)
	if err != nil || info.Size != int64(len(whole)) || info.ContentType != "video/mp4" {
		t.Fatalf("%+v %v", info, err)
	}
	dst := filepath.Join(t.TempDir(), "source")
	if err := c.Download(ctx, testkit.RawBucket, key, dst); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(dst); !bytes.Equal(got, whole) {
		t.Fatal("downloaded content differs from what was uploaded")
	}

	// Completed uploads are gone: real Garage error codes map to the sentinels.
	if err := c.CompleteMultipart(ctx, testkit.RawBucket, key, id, parts); !errors.Is(err, s3x.ErrNoSuchUpload) {
		t.Errorf("complete twice: %v", err)
	}
	if err := c.AbortMultipart(ctx, testkit.RawBucket, key, id); !errors.Is(err, s3x.ErrNoSuchUpload) {
		t.Errorf("abort after complete: %v", err)
	}
	id2, _ := c.CreateMultipart(ctx, testkit.RawBucket, "other", "video/mp4")
	if err := c.CompleteMultipart(ctx, testkit.RawBucket, "other", id2, []s3x.Part{{Number: 1, ETag: `"deadbeef"`}}); !errors.Is(err, s3x.ErrInvalidPart) {
		t.Errorf("wrong etag: %v", err)
	}
	if err := c.AbortMultipart(ctx, testkit.RawBucket, "other", id2); err != nil {
		t.Errorf("abort: %v", err)
	}
}

func TestGarageObjectsHeadersAndErrors(t *testing.T) {
	c, g := garageClient(t)
	ctx := context.Background()

	if err := c.Ping(ctx, testkit.MediaBucket); err != nil {
		t.Fatal(err)
	}
	if err := c.Ping(ctx, "no-such-bucket"); err == nil {
		t.Error("ping of a missing bucket must fail")
	}
	if _, err := c.Head(ctx, testkit.MediaBucket, "missing"); !errors.Is(err, s3x.ErrNotFound) {
		t.Errorf("head missing: %v", err)
	}
	if err := c.Delete(ctx, testkit.MediaBucket, "missing"); err != nil {
		t.Errorf("delete missing: %v", err)
	}

	p := filepath.Join(t.TempDir(), "seg")
	_ = os.WriteFile(p, []byte("hello"), 0o644)
	if err := c.UploadFile(ctx, testkit.MediaBucket, "v/x/a1/hls/seg_00000.m4s", p,
		s3x.PutOptions{ContentType: "video/mp4", CacheControl: "public, max-age=31536000, immutable"}); err != nil {
		t.Fatal(err)
	}
	out, err := g.S3Client().HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(testkit.MediaBucket), Key: aws.String("v/x/a1/hls/seg_00000.m4s")})
	if err != nil || aws.ToString(out.ContentType) != "video/mp4" || aws.ToString(out.CacheControl) != "public, max-age=31536000, immutable" || aws.ToInt64(out.ContentLength) != 5 {
		t.Fatalf("stored headers: %+v %v", out, err)
	}
	if err := c.Download(ctx, testkit.MediaBucket, "nope", filepath.Join(t.TempDir(), "d")); !errors.Is(err, s3x.ErrNotFound) {
		t.Errorf("download missing: %v", err)
	}
}

// DeletePrefix and ListPrefixes on real Garage, with more than 1000 objects so
// listing paginates and DeleteObjects runs at its batch limit.
func TestGarageDeletePrefixAndListPrefixes(t *testing.T) {
	c, _ := garageClient(t)
	ctx := context.Background()
	sdk := c.SDK()
	put := func(key string) {
		if _, err := sdk.PutObject(ctx, &s3.PutObjectInput{Bucket: aws.String(testkit.MediaBucket), Key: aws.String(key), Body: strings.NewReader("x")}); err != nil {
			t.Fatal(err)
		}
	}
	const n = 1100
	for i := 0; i < n; i++ {
		put(fmt.Sprintf("v/big/a1/hls/seg_%05d.m4s", i))
	}
	put("v/big/a2/hls/master.m3u8")
	put("v/bigger/a1/keep") // shares the textual prefix "v/big"
	put("v/other/a1/keep")

	subs, err := c.ListPrefixes(ctx, testkit.MediaBucket, "v/big/")
	if err != nil || strings.Join(subs, ",") != "v/big/a1/,v/big/a2/" {
		t.Fatalf("%v %v", subs, err)
	}
	if err := c.DeletePrefix(ctx, testkit.MediaBucket, "v/big/a1/"); err != nil {
		t.Fatal(err)
	}
	left := func(prefix string) int {
		p := s3.NewListObjectsV2Paginator(sdk, &s3.ListObjectsV2Input{Bucket: aws.String(testkit.MediaBucket), Prefix: aws.String(prefix)})
		total := 0
		for p.HasMorePages() {
			page, err := p.NextPage(ctx)
			if err != nil {
				t.Fatal(err)
			}
			total += len(page.Contents)
		}
		return total
	}
	if left("v/big/a1/") != 0 {
		t.Fatalf("%d objects left under v/big/a1/", left("v/big/a1/"))
	}
	if left("v/big/a2/") != 1 || left("v/bigger/") != 1 || left("v/other/") != 1 {
		t.Fatal("DeletePrefix removed objects outside its prefix")
	}
	if err := c.DeletePrefix(ctx, testkit.MediaBucket, "v/big/"); err != nil || left("v/big/") != 0 {
		t.Fatalf("second delete: %v (%d left)", err, left("v/big/"))
	}
}
