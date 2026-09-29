package storage

import (
	"context"
	"errors"
	"net/url"
	"testing"
	"time"

	"github.com/luantpbk/winkey/libs/go/s3x"
	"github.com/luantpbk/winkey/services/upload/internal/domain"
)

func adapter(t *testing.T, public string) *S3 {
	t.Helper()
	c, err := s3x.New(s3x.Config{
		Endpoint: "http://garage.internal:3900", PublicEndpoint: public,
		Region: "garage", AccessKeyID: "GKtest", SecretAccessKey: "secret",
	})
	if err != nil {
		t.Fatal(err)
	}
	return New(c)
}

// The adapter must presign for the PUBLIC host (the s3x unit tests cover the
// signing details).
func TestPresignPartUsesPublicEndpoint(t *testing.T) {
	raw, err := adapter(t, "https://s3.winkey.vn").PresignPart(context.Background(), "winkey-raw", "owner/vid/source", "upload-1", 3, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(raw)
	if u.Host != "s3.winkey.vn" || u.Path != "/winkey-raw/owner/vid/source" || u.Query().Get("partNumber") != "3" {
		t.Fatalf("%s", raw)
	}
}

// Presigning without a public endpoint must fail loudly, never sign for the internal host.
func TestPresignPartWithoutPublicEndpointFails(t *testing.T) {
	_, err := adapter(t, "").PresignPart(context.Background(), "b", "k", "u", 1, time.Hour)
	if !errors.Is(err, s3x.ErrNoPublicEndpoint) {
		t.Fatalf("%v", err)
	}
}

// The domain errors the handlers and the janitor branch on are the s3x sentinels,
// so errors.Is works straight through the adapter.
func TestDomainErrorsAreTheSharedSentinels(t *testing.T) {
	for name, pair := range map[string][2]error{
		"no such upload": {domain.ErrNoSuchUpload, s3x.ErrNoSuchUpload},
		"invalid part":   {domain.ErrInvalidPart, s3x.ErrInvalidPart},
		"no such object": {domain.ErrNoSuchObject, s3x.ErrNotFound},
	} {
		if !errors.Is(pair[0], pair[1]) {
			t.Errorf("%s: domain error is not the s3x sentinel", name)
		}
	}
}
