package storage

import (
	"context"
	"net/url"
	"strings"
	"testing"
	"time"
)

// The signature is bound to the host, so presigned URLs must point at the
// public endpoint, use path-style addressing and carry no SDK checksum params
// (browsers PUT the raw part body).
func TestPresignUsesPublicEndpoint(t *testing.T) {
	s := New(Config{
		Endpoint: "http://garage.internal:3900", PublicEndpoint: "https://s3.winkey.vn",
		Region: "garage", AccessKeyID: "GKtest", SecretKey: "secret",
	})
	raw, err := s.PresignPart(context.Background(), "winkey-raw", "owner/vid/source", "upload-1", 3, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if u.Scheme != "https" || u.Host != "s3.winkey.vn" {
		t.Errorf("host %s://%s, want https://s3.winkey.vn", u.Scheme, u.Host)
	}
	if u.Path != "/winkey-raw/owner/vid/source" {
		t.Errorf("path %q not path-style", u.Path)
	}
	q := u.Query()
	if q.Get("partNumber") != "3" || q.Get("uploadId") != "upload-1" {
		t.Errorf("query %v", q)
	}
	if q.Get("X-Amz-Expires") != "3600" || q.Get("X-Amz-Algorithm") != "AWS4-HMAC-SHA256" {
		t.Errorf("signing params %v", q)
	}
	if !strings.Contains(q.Get("X-Amz-Credential"), "/garage/s3/aws4_request") {
		t.Errorf("credential scope %q", q.Get("X-Amz-Credential"))
	}
	for k := range q {
		if strings.Contains(strings.ToLower(k), "checksum") {
			t.Errorf("unexpected checksum parameter %s", k)
		}
	}
	if sh := q.Get("X-Amz-SignedHeaders"); sh != "host" {
		t.Errorf("signed headers %q, want only host", sh)
	}
}
