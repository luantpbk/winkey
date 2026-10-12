package main

import (
	"bytes"
	"strings"
	"testing"
)

func rows(setting string, b1080, b720 int64, v1080, v720 float64) []result {
	return []result{
		{Input: "s01", Setting: setting, Rendition: "1080p", Bytes: b1080, VMAFMean: v1080},
		{Input: "s01", Setting: setting, Rendition: "720p", Bytes: b720, VMAFMean: v720},
	}
}

func TestEvaluateAndRecommend(t *testing.T) {
	var all []result
	all = append(all, rows("abr", 1000, 600, 95, 88)...)
	all = append(all, rows("capped_crf:21", 900, 500, 94.8, 87.5)...) // 12.5% saved: too little
	all = append(all, rows("capped_crf:23", 700, 400, 94.5, 86.0)...) // 31% saved, drops 0.5 / 2.0: pass
	all = append(all, rows("capped_crf:25", 500, 300, 93.0, 84.0)...) // 50% saved, top drop 2.0: fail

	vs := evaluate(all, "abr")
	if len(vs) != 3 {
		t.Fatalf("verdicts: %+v", vs)
	}
	got := map[string]verdict{}
	for _, v := range vs {
		got[v.Setting] = v
	}
	if got["capped_crf:21"].Pass || !got["capped_crf:23"].Pass || got["capped_crf:25"].Pass {
		t.Fatalf("pass flags wrong: %+v", vs)
	}
	if v := got["capped_crf:23"]; v.SavedPct < 31 || v.SavedPct > 31.5 || v.TopDrop != 0.5 || v.LowerDrop != 2.0 {
		t.Fatalf("capped_crf:23 numbers: %+v", v)
	}
	if r := recommend(vs); r != "capped_crf:23" {
		t.Fatalf("recommend = %q", r)
	}

	var buf bytes.Buffer
	printVerdicts(&buf, vs, "abr")
	if !strings.Contains(buf.String(), "RECOMMENDED: capped_crf:23") {
		t.Fatalf("output:\n%s", buf.String())
	}
}

func TestRecommendNoneWhenNothingPasses(t *testing.T) {
	var all []result
	all = append(all, rows("abr", 1000, 600, 95, 88)...)
	all = append(all, rows("capped_crf:25", 500, 300, 90, 80)...)
	vs := evaluate(all, "abr")
	if recommend(vs) != "" {
		t.Fatal("nothing should pass")
	}
	var buf bytes.Buffer
	printVerdicts(&buf, vs, "abr")
	if !strings.Contains(buf.String(), "RECOMMENDED: none (keep RATE_CONTROL=abr)") {
		t.Fatalf("output:\n%s", buf.String())
	}
}

func TestTopRenditionIsPerSource(t *testing.T) {
	// A 720p-only source: its 720p is its top rendition.
	all := []result{
		{Input: "small", Setting: "abr", Rendition: "720p", Bytes: 1000, VMAFMean: 95},
		{Input: "small", Setting: "capped_crf:23", Rendition: "720p", Bytes: 500, VMAFMean: 93},
	}
	vs := evaluate(all, "abr")
	if vs[0].TopDrop != 2 || vs[0].LowerDrop != 0 || vs[0].Pass {
		t.Fatalf("%+v", vs[0])
	}
}
