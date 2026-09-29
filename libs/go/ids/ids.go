// Package ids generates the UUIDv7 identifiers mandated by ADR-010.
package ids

import (
	"errors"

	"github.com/google/uuid"
)

// New returns a new UUIDv7. It panics only if the system random source fails,
// which is unrecoverable anyway.
func New() uuid.UUID {
	id, err := uuid.NewV7()
	if err != nil {
		panic("ids: cannot generate UUIDv7: " + err.Error())
	}
	return id
}

// NewString returns a new UUIDv7 in canonical text form.
func NewString() string { return New().String() }

// Parse parses a canonical UUID string and rejects anything that is not one.
func Parse(s string) (uuid.UUID, error) {
	if len(s) != 36 {
		return uuid.Nil, errors.New("ids: not a canonical UUID")
	}
	return uuid.Parse(s)
}
