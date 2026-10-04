// Package recoab assigns authenticated viewers to ADR-030's recommendation experiment.
package recoab

import (
	"crypto/sha256"
	"encoding/binary"

	"github.com/google/uuid"
)

// Variant is shared by feed requests and playback events. percent is validated at startup.
func Variant(seed string, percent int, userID uuid.UUID) string {
	hash := sha256.Sum256([]byte(seed + ":" + userID.String()))
	bucket := int(binary.BigEndian.Uint64(hash[:8]) % 100)
	if bucket < percent {
		return "reco"
	}
	return "control"
}
