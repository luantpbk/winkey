package av1up

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"
)

// AV1 policy (task AV1POL, ADR-048): only the TopN most watched READY videos get an AV1 set, and a set is
// dropped once its video falls below rank KeepTop (hysteresis, so a video hovering around rank TopN is not
// encoded and deleted night after night). TopN < 0 means every video (no drops). Dropping is two-phase: the
// database forgets the set at once (video-svc stops returning hls_av1_url within its 30 s cache), and the
// objects are deleted by the next run, so a viewer who already loaded the AV1 master can finish watching.

// AllVideos is TopN for "every READY video".
const AllVideos = -1

// Rank is one READY video in watch order (7-day starts DESC, then newest).
type Rank struct {
	ID       uuid.UUID
	Starts7d int64
	HasAV1   bool
}

// PolicyStore is the persistence the policy needs on top of Store.
type PolicyStore interface {
	// RankAV1 returns every READY video, most watched over the last 7 days first, then newest.
	RankAV1(ctx context.Context) ([]Rank, error)
	// DropAV1, in one transaction holding the video row lock, clears hls_av1_master_key and the codec='av1'
	// renditions. ok is false when the video has no AV1 set any more.
	DropAV1(ctx context.Context, id uuid.UUID) (ok bool, err error)
}

// ParseTopN reads AV1_TOP_N: "all" or a number >= 0.
func ParseTopN(s string) (int, error) {
	s = strings.TrimSpace(strings.ToLower(s))
	if s == "" || s == "all" {
		return AllVideos, nil
	}
	var n int
	if _, err := fmt.Sscanf(s, "%d", &n); err != nil || n < 0 || fmt.Sprint(n) != s {
		return 0, fmt.Errorf("AV1_TOP_N must be 'all' or a whole number >= 0, got %q", s)
	}
	return n, nil
}

// KeepTop is the rank below which a set is dropped: keep when >= topN (0 = automatic: max(2N, N+5)).
func KeepTop(topN, keep int) int {
	if topN == AllVideos {
		return AllVideos
	}
	if keep >= topN && keep > 0 {
		return keep
	}
	if topN == 0 {
		return 0
	}
	return max(2*topN, topN+5)
}

// PolicyPlan says which videos may be upgraded and which sets to drop.
type PolicyPlan struct {
	Eligible map[uuid.UUID]bool // ranks within TopN (nil: every video)
	Drop     []uuid.UUID        // have a set and rank at or beyond KeepTop
	NoAV1    []uuid.UUID        // READY videos without a set (their leftover av1/ directories are garbage)
}

// Plan applies the policy to a ranking.
func Plan(ranks []Rank, topN, keepTop int) PolicyPlan {
	var p PolicyPlan
	if topN != AllVideos {
		p.Eligible = map[uuid.UUID]bool{}
	}
	for i, r := range ranks {
		if topN != AllVideos && i < topN {
			p.Eligible[r.ID] = true
		}
		switch {
		case r.HasAV1 && keepTop != AllVideos && i >= keepTop:
			p.Drop = append(p.Drop, r.ID)
		case !r.HasAV1:
			p.NoAV1 = append(p.NoAV1, r.ID)
		}
	}
	return p
}
