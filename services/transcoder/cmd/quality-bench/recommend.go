package main

import (
	"fmt"
	"io"
	"sort"
)

// ADR-039 acceptance criteria for switching a setting on in production.
const (
	maxTopDrop      = 1.0  // mean VMAF drop allowed on each source's top rendition
	maxLowerDrop    = 3.0  // mean VMAF drop allowed on the lower renditions
	minSizeSavedPct = 20.0 // default: total segment bytes saved vs the baseline, in percent (ADR-041 uses 25)
)

// verdict is one setting compared with the baseline over every source.
type verdict struct {
	Setting      string
	SavedPct     float64 // total bytes saved vs baseline (negative = bigger)
	TopDrop      float64 // mean VMAF drop on top renditions
	LowerDrop    float64 // mean VMAF drop on lower renditions
	WorstTopDrop float64 // largest single top-rendition drop
	Pass         bool
}

// evaluate compares every non-baseline setting with the baseline (the first
// setting) on the renditions both have. The top rendition of a source is the
// one with the highest ladder name (1080p before 720p).
func evaluate(all []result, baseline string, minSaved float64) []verdict {
	type key struct{ input, rendition string }
	base := map[key]result{}
	top := map[string]string{}
	for _, r := range all {
		if r.Setting != baseline {
			continue
		}
		base[key{r.Input, r.Rendition}] = r
		if t, ok := top[r.Input]; !ok || renditionHeight(r.Rendition) > renditionHeight(t) {
			top[r.Input] = r.Rendition
		}
	}
	type acc struct {
		baseBytes, bytes int64
		topSum, lowerSum float64
		topN, lowerN     int
		worstTop         float64
	}
	accs := map[string]*acc{}
	var order []string
	for _, r := range all {
		if r.Setting == baseline {
			continue
		}
		b, ok := base[key{r.Input, r.Rendition}]
		if !ok {
			continue
		}
		a := accs[r.Setting]
		if a == nil {
			a = &acc{}
			accs[r.Setting] = a
			order = append(order, r.Setting)
		}
		a.baseBytes += b.Bytes
		a.bytes += r.Bytes
		drop := b.VMAFMean - r.VMAFMean
		if top[r.Input] == r.Rendition {
			a.topSum += drop
			a.topN++
			a.worstTop = max(a.worstTop, drop)
		} else {
			a.lowerSum += drop
			a.lowerN++
		}
	}
	out := make([]verdict, 0, len(order))
	for _, s := range order {
		a := accs[s]
		v := verdict{Setting: s, WorstTopDrop: a.worstTop}
		if a.baseBytes > 0 {
			v.SavedPct = 100 * (1 - float64(a.bytes)/float64(a.baseBytes))
		}
		if a.topN > 0 {
			v.TopDrop = a.topSum / float64(a.topN)
		}
		if a.lowerN > 0 {
			v.LowerDrop = a.lowerSum / float64(a.lowerN)
		}
		v.Pass = a.topN > 0 && v.TopDrop <= maxTopDrop && v.LowerDrop <= maxLowerDrop && v.SavedPct >= minSaved
		out = append(out, v)
	}
	return out
}

// recommend returns the passing setting that saves the most bytes, or "".
func recommend(vs []verdict) string {
	best := ""
	bestSaved := -1.0
	for _, v := range vs {
		if v.Pass && v.SavedPct > bestSaved {
			best, bestSaved = v.Setting, v.SavedPct
		}
	}
	return best
}

func printVerdicts(w io.Writer, vs []verdict, baseline string, minSaved float64) {
	sorted := append([]verdict(nil), vs...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Setting < sorted[j].Setting })
	_, _ = fmt.Fprintf(w, "\n### ADR-039 verdict (baseline: %s)\n\n", baseline)
	_, _ = fmt.Fprintf(w, "Criteria: top-rendition VMAF drop <= %.1f, lower renditions <= %.1f, size saved >= %.0f%%.\n\n", maxTopDrop, maxLowerDrop, minSaved)
	_, _ = fmt.Fprintln(w, "| Setting | Size saved | Mean VMAF drop (top) | Worst drop (top) | Mean VMAF drop (lower) | Pass |")
	_, _ = fmt.Fprintln(w, "|---|---:|---:|---:|---:|:---:|")
	for _, v := range sorted {
		mark := "no"
		if v.Pass {
			mark = "yes"
		}
		_, _ = fmt.Fprintf(w, "| %s | %.1f%% | %.2f | %.2f | %.2f | %s |\n", v.Setting, v.SavedPct, v.TopDrop, v.WorstTopDrop, v.LowerDrop, mark)
	}
	if r := recommend(vs); r != "" {
		_, _ = fmt.Fprintf(w, "\nRECOMMENDED: %s\n", r)
	} else {
		_, _ = fmt.Fprintf(w, "\nRECOMMENDED: none (keep %s)\n", baseline)
	}
}

// renditionHeight turns "1080p" into 1080 (0 when it does not parse).
func renditionHeight(name string) int {
	n := 0
	for _, c := range name {
		if c < '0' || c > '9' {
			break
		}
		n = n*10 + int(c-'0')
	}
	return n
}
