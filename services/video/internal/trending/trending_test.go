package trending

import (
	"math"
	"testing"
	"time"
)

func TestScoreHalvesEveryTwentyFourHours(t *testing.T) {
	near := func(got, want float64) bool { return math.Abs(got-want) < 1e-9*math.Max(1, want) }
	for _, c := range []struct {
		views int64
		age   time.Duration
		want  float64
	}{
		{1, 0, 1.0},                // a view counted now
		{1, 24 * time.Hour, 0.5},   // one half life
		{1, 48 * time.Hour, 0.25},  //
		{1, 72 * time.Hour, 0.125}, // the edge of the window
		{100, 0, 100},
		{100, 24 * time.Hour, 50},
		{1000, 12 * time.Hour, 1000 * math.Sqrt(0.5)},
		{0, time.Hour, 0},
	} {
		if got := Score(c.views, c.age); !near(got, c.want) {
			t.Errorf("Score(%d, %v) = %v, want %v", c.views, c.age, got, c.want)
		}
	}
}

func TestScoreOrdersFreshViewsAboveOldOnes(t *testing.T) {
	// The example of the brief: many old views rank below fewer fresh ones.
	old := Score(1000, 71*time.Hour) // 1000 * 0.5^(71/24) ~ 129
	fresh := Score(200, 30*time.Minute)
	if !(fresh > old) {
		t.Fatalf("fresh %v old %v", fresh, old)
	}
	// Monotonic in age and in views.
	if !(Score(10, time.Hour) > Score(10, 2*time.Hour)) || !(Score(11, time.Hour) > Score(10, time.Hour)) {
		t.Fatal("not monotonic")
	}
	// Buckets add up: a view in each of two hours scores the sum of the two.
	if got, want := Score(1, time.Hour)+Score(1, 25*time.Hour), Score(1, time.Hour)*1.5; math.Abs(got-want) > 1e-9 {
		t.Fatalf("%v %v", got, want)
	}
}

func TestConstantsAreThoseOfTheADR(t *testing.T) {
	if HalfLife != 24*time.Hour || Window != 72*time.Hour || MinScore != 1 || TopN != 200 || Retention != 8*24*time.Hour {
		t.Fatal("ADR-020 constants changed")
	}
}
