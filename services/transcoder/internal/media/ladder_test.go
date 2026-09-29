package media

import (
	"fmt"
	"regexp"
	"testing"
)

func names(rs []Rendition) string {
	s := ""
	for _, r := range rs {
		s += fmt.Sprintf("%s=%dx%d@%dk ", r.Name, r.Width, r.Height, r.TargetK)
	}
	return s
}

func TestSelect(t *testing.T) {
	tests := []struct {
		name string
		w, h int
		want string
	}{
		{"landscape 1080p", 1920, 1080, "1080p=1920x1080@5000k 720p=1280x720@2800k 480p=854x480@1400k "},
		{"portrait 1080x1920", 1080, 1920, "1080p=1080x1920@5000k 720p=720x1280@2800k 480p=480x854@1400k "},
		{"4K downscales, never upscales", 3840, 2160, "1080p=1920x1080@5000k 720p=1280x720@2800k 480p=854x480@1400k "},
		{"720p source has no 1080p", 1280, 720, "720p=1280x720@2800k 480p=854x480@1400k "},
		{"1000 short edge: 720 and 480 only", 1778, 1000, "720p=1280x720@2800k 480p=854x480@1400k "},
		{"480p source", 854, 480, "480p=854x480@1400k "},
		{"360p source: one rendition at source size", 640, 360, "360p=640x360@"},
		{"portrait 360p source", 360, 640, "360p=360x640@"},
		{"ultrawide 21:9", 2560, 1080, "1080p=2560x1080@5000k 720p=1706x720@2800k 480p=1138x480@1400k "},
		{"odd source dims stay even", 1281, 721, "720p=1280x720@2800k 480p=852x480@1400k "},
		{"tiny", 64, 64, "064p=64x64@300k "},
	}
	for _, tc := range tests {
		got := names(Select(tc.w, tc.h))
		if len(tc.want) > 0 && tc.want[len(tc.want)-1] == '@' {
			if len(got) < len(tc.want) || got[:len(tc.want)] != tc.want {
				t.Errorf("%s: got %q, want prefix %q", tc.name, got, tc.want)
			}
			continue
		}
		if got != tc.want {
			t.Errorf("%s:\n got %q\nwant %q", tc.name, got, tc.want)
		}
	}
}

func TestSelectInvariants(t *testing.T) {
	nameRe := regexp.MustCompile(`^[0-9]{3,4}p$`)
	for _, sz := range [][2]int{{1920, 1080}, {1080, 1920}, {640, 360}, {2, 2}, {7680, 4320}, {1001, 563}, {333, 999}} {
		rs := Select(sz[0], sz[1])
		if len(rs) == 0 {
			t.Fatalf("%v: no renditions", sz)
		}
		for _, r := range rs {
			if r.Width%2 != 0 || r.Height%2 != 0 {
				t.Errorf("%v: odd dimensions %dx%d", sz, r.Width, r.Height)
			}
			if r.Width > sz[0]+1 || r.Height > sz[1]+1 {
				t.Errorf("%v: upscaled to %dx%d", sz, r.Width, r.Height)
			}
			if !nameRe.MatchString(r.Name) {
				t.Errorf("%v: bad name %q", sz, r.Name)
			}
			if r.MaxrateK < r.TargetK || r.BufsizeK < r.MaxrateK {
				t.Errorf("%v: inconsistent rates %+v", sz, r)
			}
		}
	}
}
