package s3x

import (
	"context"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestPresignPutSignsTypeAndLength(t *testing.T) {
	c, err := New(Config{Endpoint: "http://internal:3900", PublicEndpoint: "https://media.example.com",
		AccessKeyID: "AKIDEXAMPLE", SecretAccessKey: "secret"})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := c.PresignPut(context.Background(), "winkey-raw", "u/images/i", "image/jpeg", 12345, 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if u.Host != "media.example.com" || u.Path != "/winkey-raw/u/images/i" {
		t.Fatalf("url %s", raw)
	}
	signed := strings.Split(u.Query().Get("X-Amz-SignedHeaders"), ";")
	for _, h := range []string{"content-length", "content-type", "host"} {
		found := false
		for _, s := range signed {
			found = found || s == h
		}
		if !found {
			t.Fatalf("%s is not signed: %v", h, signed)
		}
	}
	if u.Query().Get("X-Amz-Expires") != "900" {
		t.Fatalf("expires %q", u.Query().Get("X-Amz-Expires"))
	}

	none, _ := New(Config{Endpoint: "http://internal:3900", AccessKeyID: "a", SecretAccessKey: "b"})
	if _, err := none.PresignPut(context.Background(), "b", "k", "image/png", 1, time.Minute); err != ErrNoPublicEndpoint {
		t.Fatalf("err %v", err)
	}
}
