package cursor

import (
	"encoding/json"

	"github.com/google/uuid"
)

type listPayload struct {
	ListID uuid.UUID `json:"list_id"`
	Offset int       `json:"offset"`
}

// EncodeList signs an offset in a recommendation list, scoped to the caller.
func EncodeList(secret []byte, scope string, listID uuid.UUID, offset int) string {
	body, _ := json.Marshal(listPayload{ListID: listID, Offset: offset})
	return enc.EncodeToString(body) + "." + enc.EncodeToString(mac(secret, "recommended", scope, body))
}

// DecodeList rejects malformed, cross-user, cross-endpoint and out-of-range cursors.
func DecodeList(secret []byte, scope, token string) (uuid.UUID, int, error) {
	body, err := verify(secret, "recommended", scope, token)
	if err != nil {
		return uuid.Nil, 0, err
	}
	var p listPayload
	if json.Unmarshal(body, &p) != nil || p.ListID == uuid.Nil || p.Offset < 1 || p.Offset >= 200 {
		return uuid.Nil, 0, ErrInvalid
	}
	return p.ListID, p.Offset, nil
}
