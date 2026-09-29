// Package media contains the pure (no I/O) media logic of the transcoder:
// ffprobe parsing, rendition ladder, ffmpeg argument building and progress
// parsing. Everything here is unit-testable without ffmpeg.
package media

import "fmt"

// Rung is one step of the ADR-006 ladder. Rungs are matched on the SHORT edge
// of the (rotated) picture so portrait videos get the same treatment.
type Rung struct {
	ShortEdge int
	TargetK   int // -b:v
	MaxrateK  int // -maxrate
	BufsizeK  int // -bufsize
}

// Ladder is ordered from highest to lowest quality (ADR-006).
var Ladder = []Rung{
	{ShortEdge: 1080, TargetK: 5000, MaxrateK: 5350, BufsizeK: 7500},
	{ShortEdge: 720, TargetK: 2800, MaxrateK: 2996, BufsizeK: 4200},
	{ShortEdge: 480, TargetK: 1400, MaxrateK: 1498, BufsizeK: 2100},
}

// Rendition is one output variant.
type Rendition struct {
	Name     string // "1080p": named after the short edge; matches ^[0-9]{3,4}p$
	Width    int
	Height   int
	TargetK  int
	MaxrateK int
	BufsizeK int
}

// Select returns the renditions for a picture of the given display size
// (after rotation and SAR correction), highest first. It never upscales and
// always returns at least one rendition: when the source is smaller than the
// lowest rung, a single rendition at the source size is returned with the
// lowest rung's bitrate scaled down by pixel count (floor 300 kbps).
func Select(dispW, dispH int) []Rendition {
	short := min(dispW, dispH)
	var out []Rendition
	for _, r := range Ladder {
		if r.ShortEdge > short {
			continue
		}
		w, h := scaleTo(dispW, dispH, r.ShortEdge)
		out = append(out, Rendition{
			Name: rungName(r.ShortEdge), Width: w, Height: h,
			TargetK: r.TargetK, MaxrateK: r.MaxrateK, BufsizeK: r.BufsizeK,
		})
	}
	if len(out) > 0 {
		return out
	}

	w, h := floorEven(dispW), floorEven(dispH)
	base := Ladder[len(Ladder)-1]
	basePixels := 854 * 480
	target := base.TargetK * (w * h) / basePixels
	target = max(300, min(base.TargetK, target))
	return []Rendition{{
		Name: rungName(min(w, h)), Width: w, Height: h,
		TargetK: target, MaxrateK: target * 107 / 100, BufsizeK: target * 3 / 2,
	}}
}

func rungName(short int) string { return fmt.Sprintf("%03dp", short) }

// scaleTo scales (w, h) so the short edge equals edge, keeping the aspect
// ratio with even dimensions. When the short edge already equals edge the
// source size is used (rounded down to even).
func scaleTo(w, h, edge int) (int, int) {
	if min(w, h) == edge {
		return floorEven(w), floorEven(h)
	}
	if w <= h { // portrait or square: width is the short edge
		return edge, nearestEven(float64(h) * float64(edge) / float64(w))
	}
	return nearestEven(float64(w) * float64(edge) / float64(h)), edge
}

func floorEven(v int) int { return max(2, v&^1) }

func nearestEven(v float64) int {
	n := int(v/2+0.5) * 2
	return max(2, n)
}
