package domain

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// RecommendationCandidate is a member of ADR-028's L, already ordered by score then newest.
type RecommendationCandidate struct {
	ID, OwnerID uuid.UUID
	Personal    bool
}

// RecommendationList fixes the order across pages. Only IDs and the metric mode are cached.
type RecommendationList struct {
	IDs  []uuid.UUID `json:"ids"`
	Mode string      `json:"mode"`
}

// RecommendationStore reads only PostgreSQL, including the analytics projections.
type RecommendationStore interface {
	// personalize disables only co-view/subscription scoring; viewer exclusions still apply.
	RecommendationCandidates(context.Context, string, uuid.UUID, time.Time, bool) ([]RecommendationCandidate, error)
	RecommendationPage(context.Context, []uuid.UUID, string, uuid.UUID) ([]Summary, error)
}
