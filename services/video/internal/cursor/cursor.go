// Package cursor encodes keyset pagination positions as opaque, tamper-evident
// tokens: base64url(payload) "." base64url(HMAC-SHA256 truncated to 16 bytes).
//
// The MAC covers the endpoint kind and a scope string (the filters of the
// request, e.g. the owner_id or the status), so a token cannot be replayed on
// another endpoint or with other filters, and any edit of the payload is
// rejected instead of silently starting from an arbitrary position.
package cursor

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/services/video/internal/domain"
)

// ErrInvalid is returned for any malformed, tampered or mismatched cursor.
var ErrInvalid = errors.New("invalid cursor")

// MaxLen is the contract's maxLength for the cursor parameter.
const MaxLen = 512

type payload struct {
	T  int64  `json:"t"` // unix microseconds (PostgreSQL timestamptz resolution)
	ID string `json:"i"`
}

var enc = base64.RawURLEncoding

func mac(secret []byte, kind, scope string, body []byte) []byte {
	h := hmac.New(sha256.New, secret)
	h.Write([]byte(kind))
	h.Write([]byte{0})
	h.Write([]byte(scope))
	h.Write([]byte{0})
	h.Write(body)
	return h.Sum(nil)[:16]
}

// Encode returns the token for the position after the last returned item.
func Encode(secret []byte, kind, scope string, p domain.Position) string {
	body, _ := json.Marshal(payload{T: p.T.UnixMicro(), ID: p.ID.String()})
	return enc.EncodeToString(body) + "." + enc.EncodeToString(mac(secret, kind, scope, body))
}

// Decode verifies and decodes a token issued by Encode with the same secret,
// kind and scope.
func Decode(secret []byte, kind, scope, token string) (domain.Position, error) {
	body, err := verify(secret, kind, scope, token)
	if err != nil {
		return domain.Position{}, err
	}
	var p payload
	if json.Unmarshal(body, &p) != nil {
		return domain.Position{}, ErrInvalid
	}
	id, err := uuid.Parse(p.ID)
	if err != nil {
		return domain.Position{}, ErrInvalid
	}
	return domain.Position{T: time.UnixMicro(p.T).UTC(), ID: id}, nil
}

// SearchPosition is the position of a search cursor: the mode that produced the
// page, the number of the page it leads to (1-based) and the keyset position.
type SearchPosition struct {
	Mode string
	Page int
	domain.SearchAfter
}

type searchPayload struct {
	M string `json:"m"` // fts | trgm
	P int    `json:"p"`
	R uint32 `json:"r"` // float32 bits of the rank: exact, unlike a decimal
	T int64  `json:"t"`
	I string `json:"i"`
}

// EncodeSearch returns the token for the position after the last item of a search page.
func EncodeSearch(secret []byte, kind, scope string, p SearchPosition) string {
	body, _ := json.Marshal(searchPayload{M: p.Mode, P: p.Page, R: math.Float32bits(p.Rank), T: p.T.UnixMicro(), I: p.ID.String()})
	return enc.EncodeToString(body) + "." + enc.EncodeToString(mac(secret, kind, scope, body))
}

// DecodeSearch verifies and decodes a token issued by EncodeSearch.
func DecodeSearch(secret []byte, kind, scope, token string) (SearchPosition, error) {
	body, err := verify(secret, kind, scope, token)
	if err != nil {
		return SearchPosition{}, err
	}
	var p searchPayload
	if json.Unmarshal(body, &p) != nil || (p.M != domain.SearchFTS && p.M != domain.SearchTrgm) || p.P < 2 {
		return SearchPosition{}, ErrInvalid
	}
	id, err := uuid.Parse(p.I)
	if err != nil {
		return SearchPosition{}, ErrInvalid
	}
	return SearchPosition{Mode: p.M, Page: p.P, SearchAfter: domain.SearchAfter{
		Rank: math.Float32frombits(p.R), T: time.UnixMicro(p.T).UTC(), ID: id}}, nil
}

// verify checks length, shape and MAC and returns the payload bytes.
func verify(secret []byte, kind, scope, token string) ([]byte, error) {
	if len(token) == 0 || len(token) > MaxLen {
		return nil, ErrInvalid
	}
	bodyPart, macPart, ok := strings.Cut(token, ".")
	if !ok {
		return nil, ErrInvalid
	}
	body, err1 := enc.DecodeString(bodyPart)
	got, err2 := enc.DecodeString(macPart)
	if err1 != nil || err2 != nil || !hmac.Equal(got, mac(secret, kind, scope, body)) {
		return nil, ErrInvalid
	}
	return body, nil
}

type rankPayload struct {
	R int `json:"r"`
}

// EncodeRank returns the token for the position after the item of the given rank (trending, task R2-a).
func EncodeRank(secret []byte, kind, scope string, rank int) string {
	body, _ := json.Marshal(rankPayload{R: rank})
	return enc.EncodeToString(body) + "." + enc.EncodeToString(mac(secret, kind, scope, body))
}

// DecodeRank verifies and decodes a token issued by EncodeRank.
func DecodeRank(secret []byte, kind, scope, token string) (int, error) {
	body, err := verify(secret, kind, scope, token)
	if err != nil {
		return 0, err
	}
	var p rankPayload
	if json.Unmarshal(body, &p) != nil || p.R < 1 {
		return 0, ErrInvalid
	}
	return p.R, nil
}
