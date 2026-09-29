package s3x

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newClient(t *testing.T, f *fakeS3, public string) *Client {
	t.Helper()
	c, err := New(Config{Endpoint: f.srv.URL, PublicEndpoint: public, AccessKeyID: "GKtest", SecretAccessKey: "topsecret"})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestConfigValidation(t *testing.T) {
	good := Config{Endpoint: "http://garage:3900", AccessKeyID: "k", SecretAccessKey: "s"}
	if _, err := New(good); err != nil {
		t.Fatal(err)
	}
	for name, c := range map[string]Config{
		"no endpoint":         {AccessKeyID: "k", SecretAccessKey: "s"},
		"bad scheme":          {Endpoint: "ftp://x", AccessKeyID: "k", SecretAccessKey: "s"},
		"no host":             {Endpoint: "http://", AccessKeyID: "k", SecretAccessKey: "s"},
		"relative":            {Endpoint: "garage:3900", AccessKeyID: "k", SecretAccessKey: "s"},
		"bad public endpoint": {Endpoint: "http://x", PublicEndpoint: "s3.winkey.vn", AccessKeyID: "k", SecretAccessKey: "s"},
		"no key":              {Endpoint: "http://x", SecretAccessKey: "s"},
		"no secret":           {Endpoint: "http://x", AccessKeyID: "k"},
	} {
		if _, err := New(c); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// Several problems are reported together and never echo the secret.
	_, err := New(Config{Endpoint: "nope", PublicEndpoint: "nope2", SecretAccessKey: "hunter2"})
	if err == nil || strings.Contains(err.Error(), "hunter2") || strings.Count(err.Error(), "\n") < 2 {
		t.Fatalf("error: %v", err)
	}
	c, _ := New(good)
	if c.cfg.Region != DefaultRegion || DefaultRegion != "garage" {
		t.Fatalf("region %q", c.cfg.Region)
	}
}

// The signature is bound to the host, so presigned URLs must point at the
// public endpoint, be path-style, and carry no SDK checksum parameters (a
// browser PUTs the raw part body). Nothing may be sent to the server.
func TestPresignUsesPublicEndpoint(t *testing.T) {
	f := newFake(t)
	c := newClient(t, f, "https://s3.winkey.vn")
	raw, err := c.PresignUploadPart(context.Background(), "winkey-raw", "owner/vid/source", "upload-1", 3, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(raw)
	q := u.Query()
	if u.Scheme != "https" || u.Host != "s3.winkey.vn" || u.Path != "/winkey-raw/owner/vid/source" {
		t.Errorf("url %s", raw)
	}
	if q.Get("partNumber") != "3" || q.Get("uploadId") != "upload-1" || q.Get("X-Amz-Expires") != "3600" ||
		q.Get("X-Amz-SignedHeaders") != "host" || !strings.Contains(q.Get("X-Amz-Credential"), "/garage/s3/aws4_request") {
		t.Errorf("signing params %v", q)
	}
	for k := range q {
		if strings.Contains(strings.ToLower(k), "checksum") {
			t.Errorf("unexpected checksum parameter %s", k)
		}
	}
	if len(f.calls) != 0 {
		t.Errorf("presigning made requests: %v", f.calls)
	}
}

func TestPresignWithoutPublicEndpointIsRefused(t *testing.T) {
	c := newClient(t, newFake(t), "")
	if _, err := c.PresignUploadPart(context.Background(), "b", "k", "u", 1, time.Hour); !errors.Is(err, ErrNoPublicEndpoint) {
		t.Fatalf("got %v; presigning for the internal host would hand out unusable URLs", err)
	}
}

func TestHeadPingDelete(t *testing.T) {
	f := newFake(t)
	f.put("b", "here", []byte("12345"))
	c := newClient(t, f, "")
	ctx := context.Background()

	info, err := c.Head(ctx, "b", "here")
	if err != nil || info.Size != 5 || info.ETag == "" || info.ContentType != "video/mp4" {
		t.Fatalf("%+v %v", info, err)
	}
	if _, err := c.Head(ctx, "b", "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
	if err := c.Ping(ctx, "b"); err != nil {
		t.Fatal(err)
	}
	if err := c.Ping(ctx, "nobucket"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing bucket: %v", err)
	}
	if err := c.Delete(ctx, "b", "here"); err != nil || f.has("b", "here") {
		t.Fatalf("delete: %v", err)
	}
	if err := c.Delete(ctx, "b", "never-existed"); err != nil {
		t.Fatalf("deleting a missing object must succeed: %v", err)
	}
}

func TestMultipartErrorMapping(t *testing.T) {
	c := newClient(t, newFake(t), "")
	ctx := context.Background()
	id, err := c.CreateMultipart(ctx, "b", "k", "video/mp4")
	if err != nil || id != "upload-1" {
		t.Fatalf("%q %v", id, err)
	}
	parts := []Part{{1, `"a"`}, {2, `"b"`}}
	if err := c.CompleteMultipart(ctx, "b", "k", id, parts); err != nil {
		t.Fatal(err)
	}
	if err := c.CompleteMultipart(ctx, "b", "k", "gone", parts); !errors.Is(err, ErrNoSuchUpload) {
		t.Errorf("gone: %v", err)
	}
	for _, up := range []string{"badpart", "toosmall"} {
		if err := c.CompleteMultipart(ctx, "b", "k", up, parts); !errors.Is(err, ErrInvalidPart) {
			t.Errorf("%s: %v", up, err)
		}
	}
	if err := c.AbortMultipart(ctx, "b", "k", id); err != nil {
		t.Fatal(err)
	}
	if err := c.AbortMultipart(ctx, "b", "k", "gone"); !errors.Is(err, ErrNoSuchUpload) {
		t.Errorf("abort gone: %v", err)
	}
	// Unmapped errors keep the underlying cause and the operation name.
	c2, _ := New(Config{Endpoint: "http://127.0.0.1:1", AccessKeyID: "k", SecretAccessKey: "s"})
	short, cancel := context.WithTimeout(ctx, 300*time.Millisecond) // the SDK retries refused connections
	defer cancel()
	err = c2.Delete(short, "b", "k")
	if err == nil || !strings.Contains(err.Error(), "delete object") || errors.Is(err, ErrNotFound) {
		t.Errorf("connection error: %v", err)
	}
}

func TestUploadFileSendsHeaders(t *testing.T) {
	f := newFake(t)
	c := newClient(t, f, "")
	dir := t.TempDir()
	p := filepath.Join(dir, "seg.m4s")
	if err := os.WriteFile(p, []byte("segment-bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := c.UploadFile(ctx, "media", "v/1/a1/seg.m4s", p, PutOptions{ContentType: "video/mp4", CacheControl: "public, max-age=31536000, immutable"}); err != nil {
		t.Fatal(err)
	}
	o := f.objs["media/v/1/a1/seg.m4s"]
	if string(o.data) != "segment-bytes" || o.contentType != "video/mp4" || o.cacheControl != "public, max-age=31536000, immutable" {
		t.Fatalf("%+v", o)
	}
	if err := c.UploadFile(ctx, "media", "plain", p, PutOptions{}); err != nil {
		t.Fatal(err)
	}
	if o := f.objs["media/plain"]; string(o.data) != "segment-bytes" || o.cacheControl != "" {
		t.Fatalf("no options: %+v", o)
	}
	if err := c.UploadFile(ctx, "media", "k", filepath.Join(dir, "nope"), PutOptions{}); err == nil {
		t.Fatal("missing source file must fail")
	}
}

func TestDownloadRangedAndCleansUp(t *testing.T) {
	f := newFake(t)
	data := bytes.Repeat([]byte("0123456789abcdef"), (35<<20)/16) // 35 MiB: three 16 MiB ranges
	f.put("raw", "u/v/source", data)
	c := newClient(t, f, "")
	dst := filepath.Join(t.TempDir(), "source")
	if err := c.Download(context.Background(), "raw", "u/v/source", dst); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(dst)
	if !bytes.Equal(got, data) {
		t.Fatalf("content differs (%d vs %d bytes)", len(got), len(data))
	}
	if n := f.callsMatching("GET /raw/u/v/source"); n < 3 {
		t.Errorf("%d requests: expected the download to be split into ranges", n)
	}

	missing := filepath.Join(t.TempDir(), "missing")
	if err := c.Download(context.Background(), "raw", "nope", missing); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Fatal("a failed download left a partial file behind")
	}
}

func TestDeletePrefixGuards(t *testing.T) {
	f := newFake(t)
	f.put("b", "v/abc/x", []byte("1"))
	f.put("b", "v/abcd/x", []byte("1"))
	c := newClient(t, f, "")
	for _, bad := range []string{"", "v/abc", "v"} {
		if err := c.DeletePrefix(context.Background(), "b", bad); err == nil {
			t.Errorf("prefix %q accepted", bad)
		}
	}
	if len(f.calls) != 0 || f.count("b/") != 2 {
		t.Fatalf("a refused prefix must not touch the store: calls=%v", f.calls)
	}
}

func TestDeletePrefixAcrossPages(t *testing.T) {
	for _, failBulk := range []bool{false, true} {
		t.Run(fmt.Sprintf("bulk_rejected=%v", failBulk), func(t *testing.T) {
			f := newFake(t)
			f.failBulk = failBulk
			for i := 0; i < 8; i++ { // 3 pages of 3, 3, 2
				f.put("b", fmt.Sprintf("v/abc/a1/hls/seg_%d.m4s", i), []byte("x"))
			}
			f.put("b", "v/abcd/keep", []byte("x")) // sibling with the same textual prefix
			f.put("b", "other/keep", []byte("x"))
			c := newClient(t, f, "")

			if err := c.DeletePrefix(context.Background(), "b", "v/abc/"); err != nil {
				t.Fatal(err)
			}
			if f.count("b/v/abc/") != 0 {
				t.Fatalf("%d objects left", f.count("b/v/abc/"))
			}
			if !f.has("b", "v/abcd/keep") || !f.has("b", "other/keep") {
				t.Fatal("deleted something outside the prefix")
			}
			if failBulk && f.callsMatching("DELETE /b/v/abc/") != 8 {
				t.Errorf("fallback should delete each object once, got %d", f.callsMatching("DELETE /b/v/abc/"))
			}
			if !failBulk && f.callsMatching("POST /b?delete") != 3 {
				t.Errorf("expected one bulk delete per page, got %d", f.callsMatching("POST /b?delete"))
			}
		})
	}
}

func TestDeletePrefixStopsOnCancel(t *testing.T) {
	f := newFake(t)
	f.put("b", "v/x/1", []byte("x"))
	c := newClient(t, f, "")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := c.DeletePrefix(ctx, "b", "v/x/"); err == nil {
		t.Fatal("expected an error on a cancelled context")
	}
	if !f.has("b", "v/x/1") {
		t.Fatal("deleted after cancellation")
	}
}

func TestListPrefixes(t *testing.T) {
	f := newFake(t)
	for _, k := range []string{"v/id/a1/hls/m.m3u8", "v/id/a1/thumb/p.jpg", "v/id/a2/hls/m.m3u8", "v/id/a3/x", "v/id/a10/x", "v/id/note.txt", "v/other/a1/x"} {
		f.put("media", k, []byte("x"))
	}
	c := newClient(t, f, "")
	got, err := c.ListPrefixes(context.Background(), "media", "v/id/") // page size 3 forces pagination
	if err != nil || strings.Join(got, ",") != "v/id/a1/,v/id/a10/,v/id/a2/,v/id/a3/" {
		t.Fatalf("%v %v", got, err)
	}
	if got, _ = c.ListPrefixes(context.Background(), "media", "v/nothing/"); len(got) != 0 {
		t.Fatalf("%v", got)
	}
}
