package api

import (
	"reflect"
	"testing"

	"github.com/google/uuid"
	"github.com/luantpbk/winkey/services/video/internal/domain"
)

func TestRecommendedGreedyDiversityAndFallback(t *testing.T) {
	channel := uuid.New()
	var list []domain.RecommendationCandidate
	for i := 0; i < 5; i++ {
		list = append(list, domain.RecommendationCandidate{ID: uuid.New(), OwnerID: channel})
	}
	for i := 0; i < 24; i++ {
		list = append(list, domain.RecommendationCandidate{ID: uuid.New(), OwnerID: uuid.New()})
	}
	got := DiversifyRecommended(list)
	// First compatible remaining selection: positions 1,2,11,12,21 hold the dominant channel.
	want := []uuid.UUID{list[0].ID, list[1].ID}
	for _, span := range [][2]int{{5, 13}, {2, 4}, {13, 21}, {4, 5}, {21, 29}} {
		for i := span[0]; i < span[1]; i++ {
			want = append(want, list[i].ID)
		}
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatal("greedy diversity order differs")
	}
	if one := DiversifyRecommended(list[:5]); len(one) != 5 {
		t.Fatal("single-channel pool lost candidates")
	}
	var big []domain.RecommendationCandidate
	for i := 0; i < 205; i++ {
		big = append(big, domain.RecommendationCandidate{ID: uuid.New(), OwnerID: channel})
	}
	if len(DiversifyRecommended(big)) != 200 {
		t.Fatal("list cap differs")
	}
	for _, raw := range []string{"?limit=0", "?limit=51", "?limit=abc", "?limit=", "?limit=1&limit=2", "?cursor=bad", "?cursor="} {
		e := newEnv(t, false)
		if w := e.req(anon, "GET", "/v1/feed/recommended"+raw, ""); w.Code != 400 {
			t.Fatalf("%s: %d", raw, w.Code)
		}
	}
}
