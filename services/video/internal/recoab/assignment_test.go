package recoab

import (
	"math/rand"
	"testing"

	"github.com/google/uuid"
)

func TestVariantFixedVectorsAndBoundaries(t *testing.T) {
	// Buckets calculated independently using Python hashlib.sha256 and int.from_bytes(..., 'big').
	for _, tc := range []struct {
		seed, id string
		bucket   int
	}{
		{"r2ab-1", "00000000-0000-0000-0000-000000000000", 7},
		{"r2ab-1", "0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c0d", 19},
		{"r2ab-1", "ffffffff-ffff-ffff-ffff-ffffffffffff", 86},
		{"r2ab-2", "0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c0d", 9},
	} {
		id := uuid.MustParse(tc.id)
		for percent, want := range map[int]string{0: "control", tc.bucket: "control", tc.bucket + 1: "reco", 100: "reco"} {
			if got := Variant(tc.seed, percent, id); got != want {
				t.Errorf("seed %s percent %d bucket %d: got %s want %s", tc.seed, percent, tc.bucket, got, want)
			}
		}
	}
}

func TestVariantDistribution(t *testing.T) {
	// Reproducible random UUIDs keep the distribution check stable between CI runs.
	rng := rand.New(rand.NewSource(30))
	reco := 0
	for range 10000 {
		id, err := uuid.NewRandomFromReader(rng)
		if err != nil {
			t.Fatal(err)
		}
		if Variant("r2ab-1", 50, id) == "reco" {
			reco++
		}
	}
	t.Logf("reco=%d/10000 (%.2f%%)", reco, float64(reco)/100)
	if reco < 4800 || reco > 5200 {
		t.Fatalf("reco distribution outside 48..52%%: %d", reco)
	}
}
