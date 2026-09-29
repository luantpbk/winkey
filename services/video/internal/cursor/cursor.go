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
	if len(token) == 0 || len(token) > MaxLen {
		return domain.Position{}, ErrInvalid
	}
	bodyPart, macPart, ok := strings.Cut(token, ".")
	if !ok {
		return domain.Position{}, ErrInvalid
	}
	body, err1 := enc.DecodeString(bodyPart)
	got, err2 := enc.DecodeString(macPart)
	if err1 != nil || err2 != nil || !hmac.Equal(got, mac(secret, kind, scope, body)) {
		return domain.Position{}, ErrInvalid
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
