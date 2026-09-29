package cursor

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/services/video/internal/domain"
)

var secret = []byte("0123456789abcdef-test-secret")

func pos() domain.Position {
	return domain.Position{T: time.Date(2026, 10, 1, 8, 0, 0, 123456000, time.UTC), ID: uuid.MustParse("0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c0d")}
}

func TestRoundTripKeepsMicroseconds(t *testing.T) {
	tok := Encode(secret, "feed", "all", pos())
	got, err := Decode(secret, "feed", "all", tok)
	if err != nil || !got.T.Equal(pos().T) || got.ID != pos().ID {
		t.Fatalf("%+v %v", got, err)
	}
	if len(tok) > MaxLen {
		t.Fatalf("token is %d bytes, contract allows %d", len(tok), MaxLen)
	}
	if strings.ContainsAny(tok, "+/=") {
		t.Fatalf("not base64url: %s", tok)
	}
}

func TestRejectsTamperingAndReplay(t *testing.T) {
	tok := Encode(secret, "feed", "owner=a", pos())
	body, mac, _ := strings.Cut(tok, ".")

	flip := func(s string) string { // change one character
		b := []byte(s)
		if b[3] == 'A' {
			b[3] = 'B'
		} else {
			b[3] = 'A'
		}
		return string(b)
	}
	cases := map[string]string{
		"edited payload":  flip(body) + "." + mac,
		"edited mac":      body + "." + flip(mac),
		"no mac":          body,
		"empty":           "",
		"garbage":         "!!!.???",
		"too long":        strings.Repeat("a", MaxLen+1),
		"payload swapped": Encode(secret, "feed", "owner=a", domain.Position{T: pos().T.Add(time.Hour), ID: pos().ID})[:len(body)] + "." + mac,
	}
	for name, c := range cases {
		if _, err := Decode(secret, "feed", "owner=a", c); err != ErrInvalid {
			t.Errorf("%s: got %v, want ErrInvalid", name, err)
		}
	}
	// A valid token is bound to its endpoint, its filters and the secret.
	if _, err := Decode(secret, "studio", "owner=a", tok); err == nil {
		t.Error("token accepted on another endpoint")
	}
	if _, err := Decode(secret, "feed", "owner=b", tok); err == nil {
		t.Error("token accepted with other filters")
	}
	if _, err := Decode([]byte("another-secret-value-1234"), "feed", "owner=a", tok); err == nil {
		t.Error("token accepted with another secret")
	}
}
