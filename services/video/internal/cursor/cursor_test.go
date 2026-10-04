package cursor

import (
	"errors"
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
		if _, err := Decode(secret, "feed", "owner=a", c); !errors.Is(err, ErrInvalid) {
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

func searchPos() SearchPosition {
	return SearchPosition{Mode: domain.SearchTrgm, Page: 4, SearchAfter: domain.SearchAfter{
		Rank: 0.30000001, T: pos().T, ID: pos().ID}}
}

func TestSearchRoundTripKeepsTheRankBitForBit(t *testing.T) {
	for _, rank := range []float32{0.30000001, 0.1, 1e-7, 0.061450, 3.4028235e38} {
		p := searchPos()
		p.Rank = rank
		tok := EncodeSearch(secret, "search", "q=ha noi", p)
		got, err := DecodeSearch(secret, "search", "q=ha noi", tok)
		if err != nil || got != p {
			t.Fatalf("rank %v: %+v %v", rank, got, err)
		}
		if len(tok) > MaxLen || strings.ContainsAny(tok, "+/=") {
			t.Fatalf("token %q", tok)
		}
	}
}

func TestSearchCursorIsBoundToQueryKindAndSecret(t *testing.T) {
	tok := EncodeSearch(secret, "search", "q=ha noi", searchPos())
	for name, decode := range map[string]func() error{
		"other q":    func() error { _, err := DecodeSearch(secret, "search", "q=ha lat", tok); return err },
		"other case": func() error { _, err := DecodeSearch(secret, "search", "q=HA NOI", tok); return err },
		"other kind": func() error { _, err := DecodeSearch(secret, "feed", "q=ha noi", tok); return err },
		"other key": func() error {
			_, err := DecodeSearch([]byte("another-secret-key-1"), "search", "q=ha noi", tok)
			return err
		},
		"empty": func() error { _, err := DecodeSearch(secret, "search", "q=ha noi", ""); return err },
		"no mac": func() error {
			_, err := DecodeSearch(secret, "search", "q=ha noi", strings.Split(tok, ".")[0])
			return err
		},
		"too long": func() error {
			_, err := DecodeSearch(secret, "search", "q=ha noi", strings.Repeat("a", MaxLen+1))
			return err
		},
		"feed token": func() error {
			_, err := DecodeSearch(secret, "search", "q=ha noi", Encode(secret, "search", "q=ha noi", pos()))
			return err
		},
		"bit flipped": func() error { _, err := DecodeSearch(secret, "search", "q=ha noi", "A"+tok[1:]); return err },
	} {
		if err := decode(); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestSearchCursorRejectsBadPayloads(t *testing.T) {
	sign := func(body string) string {
		return enc.EncodeToString([]byte(body)) + "." + enc.EncodeToString(mac(secret, "search", "s", []byte(body)))
	}
	id := `"i":"0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c0d"`
	for name, body := range map[string]string{
		"bad mode":      `{"m":"x","p":2,"r":1,"t":1,` + id + `}`,
		"page 1":        `{"m":"fts","p":1,"r":1,"t":1,` + id + `}`,
		"no page":       `{"m":"fts","r":1,"t":1,` + id + `}`,
		"bad uuid":      `{"m":"fts","p":2,"r":1,"t":1,"i":"nope"}`,
		"not json":      `[`,
		"negative page": `{"m":"fts","p":-3,"r":1,"t":1,` + id + `}`,
	} {
		if _, err := DecodeSearch(secret, "search", "s", sign(body)); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := DecodeSearch(secret, "search", "s", sign(`{"m":"fts","p":2,"r":1,"t":1,`+id+`}`)); err != nil {
		t.Errorf("well-formed payload rejected: %v", err)
	}
}

func TestRankCursor(t *testing.T) {
	tok := EncodeRank(secret, "trending", "", 42)
	if got, err := DecodeRank(secret, "trending", "", tok); err != nil || got != 42 {
		t.Fatalf("%d %v", got, err)
	}
	if len(tok) > MaxLen || strings.ContainsAny(tok, "+/=") {
		t.Fatalf("token %q", tok)
	}
	for name, decode := range map[string]func() error{
		"other kind":  func() error { _, err := DecodeRank(secret, "feed", "", tok); return err },
		"other scope": func() error { _, err := DecodeRank(secret, "trending", "x", tok); return err },
		"other key":   func() error { _, err := DecodeRank([]byte("another-secret-key-1"), "trending", "", tok); return err },
		"empty":       func() error { _, err := DecodeRank(secret, "trending", "", ""); return err },
		"tampered":    func() error { _, err := DecodeRank(secret, "trending", "", "A"+tok[1:]); return err },
		"feed token": func() error {
			_, err := DecodeRank(secret, "feed", "all", Encode(secret, "feed", "all", pos()))
			return err
		},
	} {
		if err := decode(); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: %v", name, err)
		}
	}
	// A rank below 1 is not a position.
	for _, r := range []int{0, -3} {
		if _, err := DecodeRank(secret, "trending", "", EncodeRank(secret, "trending", "", r)); !errors.Is(err, ErrInvalid) {
			t.Errorf("rank %d accepted", r)
		}
	}
}
