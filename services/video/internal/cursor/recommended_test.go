package cursor

import (
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestListCursorScopeAndBounds(t *testing.T) {
	id := uuid.New()
	token := EncodeList(secret, "user-a", id, 50)
	got, n, err := DecodeList(secret, "user-a", token)
	if err != nil || got != id || n != 50 || len(token) > MaxLen {
		t.Fatal("list cursor roundtrip")
	}
	for _, bad := range []string{"", "bad", strings.Repeat("a", 513), EncodeList(secret, "user-a", id, 0), EncodeList(secret, "user-a", id, 200), EncodeList(secret, "user-a", uuid.Nil, 20), EncodeList(secret, "user-b", id, 20), EncodeRank(secret, "trending", "user-a", 20)} {
		if _, _, err := DecodeList(secret, "user-a", bad); !errors.Is(err, ErrInvalid) {
			t.Errorf("accepted invalid cursor: %v", err)
		}
	}
	if _, _, err := DecodeList([]byte("different-secret"), "user-a", token); !errors.Is(err, ErrInvalid) {
		t.Fatal("accepted different secret")
	}
}
