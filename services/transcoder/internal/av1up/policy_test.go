package av1up

import (
	"testing"

	"github.com/google/uuid"
)

func TestParseTopN(t *testing.T) {
	for in, want := range map[string]int{"all": AllVideos, "ALL": AllVideos, "": AllVideos, "0": 0, "5": 5, "100": 100} {
		if got, err := ParseTopN(in); err != nil || got != want {
			t.Errorf("%q: %d %v, want %d", in, got, err, want)
		}
	}
	for _, in := range []string{"-1", "five", "5x", "1.5", "05"} {
		if _, err := ParseTopN(in); err == nil {
			t.Errorf("%q accepted", in)
		}
	}
}

func TestKeepTop(t *testing.T) {
	cases := []struct{ top, keep, want int }{
		{AllVideos, 0, AllVideos}, {AllVideos, 50, AllVideos},
		{0, 0, 0},     // no AV1 at all: every set is dropped
		{1, 0, 6},     // max(2, 6)
		{5, 0, 10},    // max(10, 10)
		{10, 0, 20},   // max(20, 15)
		{100, 0, 200}, //
		{5, 7, 7},     // explicit
		{5, 3, 10},    // below N: automatic
	}
	for _, c := range cases {
		if got := KeepTop(c.top, c.keep); got != c.want {
			t.Errorf("KeepTop(%d, %d) = %d, want %d", c.top, c.keep, got, c.want)
		}
	}
}

func TestPlan(t *testing.T) {
	id := func(n byte) uuid.UUID { return uuid.UUID{15: n} }
	ranks := []Rank{
		{ID: id(1), Starts7d: 90, HasAV1: true},
		{ID: id(2), Starts7d: 80},
		{ID: id(3), Starts7d: 70, HasAV1: true},
		{ID: id(4), Starts7d: 10, HasAV1: true},
		{ID: id(5)},
	}
	p := Plan(ranks, 2, 3)
	if len(p.Eligible) != 2 || !p.Eligible[id(1)] || !p.Eligible[id(2)] {
		t.Errorf("eligible %v", p.Eligible)
	}
	if len(p.Drop) != 1 || p.Drop[0] != id(4) { // rank 3 (0-based) is beyond keep 3; rank 2 stays (hysteresis)
		t.Errorf("drop %v", p.Drop)
	}
	if len(p.NoAV1) != 2 || p.NoAV1[0] != id(2) || p.NoAV1[1] != id(5) {
		t.Errorf("noAV1 %v", p.NoAV1)
	}
	all := Plan(ranks, AllVideos, AllVideos)
	if all.Eligible != nil || len(all.Drop) != 0 {
		t.Errorf("all: %+v", all)
	}
	none := Plan(ranks, 0, 0)
	if len(none.Eligible) != 0 || len(none.Drop) != 3 {
		t.Errorf("top 0 must drop every set: %+v", none)
	}
}
