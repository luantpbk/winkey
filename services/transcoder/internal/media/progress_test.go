package media

import (
	"strings"
	"testing"
)

func TestProgressParser(t *testing.T) {
	stream := `frame=120
fps=60.00
out_time_us=2000000
out_time_ms=2000000
out_time=00:00:02.000000
progress=continue
frame=240
out_time_us=5000000
progress=continue
out_time_us=N/A
progress=continue
out_time_us=99000000
progress=continue
out_time_us=10000000
progress=end
`
	var got []float64
	ReadProgress(strings.NewReader(stream), 10_000_000, func(p float64) { got = append(got, p) })
	want := []float64{20, 50, 50, 99.9, 100} // N/A keeps the previous value; overshoot is capped below 100
	if len(got) != len(want) {
		t.Fatalf("got %v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("block %d: got %v want %v", i, got[i], want[i])
		}
	}
}

func TestProgressParserUnknownDuration(t *testing.T) {
	p := &ProgressParser{}
	p.Feed("out_time_us=5000000")
	if pct, ok := p.Feed("progress=continue"); !ok || pct != 0 {
		t.Fatalf("%v %v", pct, ok)
	}
	if pct, _ := p.Feed("progress=end"); pct != 100 {
		t.Fatal("end must report 100")
	}
}

func TestProgressParserIgnoresNoise(t *testing.T) {
	p := &ProgressParser{TotalUs: 1000}
	for _, l := range []string{"", "garbage", "=", "out_time_us=-5"} {
		if _, ok := p.Feed(l); ok {
			t.Errorf("line %q must not end a block", l)
		}
	}
}
