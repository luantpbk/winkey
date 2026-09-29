package media

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Variant is one #EXT-X-STREAM-INF entry of a master playlist.
type Variant struct {
	Bandwidth  int
	Resolution string
	Codecs     string
	URI        string
}

var attrRe = regexp.MustCompile(`([A-Z-]+)=("[^"]*"|[^,]*)`)

// ParseMaster extracts the variants of a master playlist.
func ParseMaster(text string) []Variant {
	var out []Variant
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	for i, l := range lines {
		rest, ok := strings.CutPrefix(l, "#EXT-X-STREAM-INF:")
		if !ok {
			continue
		}
		var v Variant
		for _, m := range attrRe.FindAllStringSubmatch(rest, -1) {
			val := strings.Trim(m[2], `"`)
			switch m[1] {
			case "BANDWIDTH":
				fmt.Sscanf(val, "%d", &v.Bandwidth)
			case "RESOLUTION":
				v.Resolution = val
			case "CODECS":
				v.Codecs = val
			}
		}
		for j := i + 1; j < len(lines); j++ {
			if s := strings.TrimSpace(lines[j]); s != "" && !strings.HasPrefix(s, "#") {
				v.URI = s
				break
			}
		}
		out = append(out, v)
	}
	return out
}

var (
	mapRe = regexp.MustCompile(`#EXT-X-MAP:URI="([^"]+)"`)
)

// VerifyOutput checks an ffmpeg HLS output directory before anything is
// uploaded: the master lists every rendition with BANDWIDTH, RESOLUTION and
// CODECS; every variant directory has its playlist, an init segment named by
// #EXT-X-MAP that exists next to it, and all listed media segments.
//
// ffmpeg appends the variant index/name to -hls_fmp4_init_filename (e.g.
// init_0.mp4), so the init file is located through #EXT-X-MAP, not by name.
func VerifyOutput(dir string, rs []Rendition) error {
	raw, err := os.ReadFile(filepath.Join(dir, MasterPlaylist))
	if err != nil {
		return fmt.Errorf("master playlist missing: %w", err)
	}
	vars := ParseMaster(string(raw))
	if len(vars) != len(rs) {
		return fmt.Errorf("master lists %d variants, want %d", len(vars), len(rs))
	}
	for i, v := range vars {
		want := rs[i]
		if v.Bandwidth <= 0 || v.Codecs == "" || v.Resolution == "" {
			return fmt.Errorf("variant %d lacks BANDWIDTH/RESOLUTION/CODECS: %+v", i, v)
		}
		if wantRes := fmt.Sprintf("%dx%d", want.Width, want.Height); v.Resolution != wantRes {
			return fmt.Errorf("variant %d resolution %s, want %s", i, v.Resolution, wantRes)
		}
		want.Name = strings.TrimSuffix(strings.TrimSuffix(v.URI, "/index.m3u8"), "\\index.m3u8")
		if want.Name != rs[i].Name {
			return fmt.Errorf("variant %d uri %q, want %s/index.m3u8", i, v.URI, rs[i].Name)
		}
		if err := verifyVariant(filepath.Join(dir, rs[i].Name)); err != nil {
			return fmt.Errorf("variant %s: %w", rs[i].Name, err)
		}
	}
	return nil
}

func verifyVariant(dir string) error {
	raw, err := os.ReadFile(filepath.Join(dir, "index.m3u8"))
	if err != nil {
		return fmt.Errorf("playlist missing: %w", err)
	}
	text := string(raw)
	m := mapRe.FindStringSubmatch(text)
	if m == nil {
		return fmt.Errorf("playlist has no #EXT-X-MAP")
	}
	if st, err := os.Stat(filepath.Join(dir, filepath.FromSlash(m[1]))); err != nil || st.Size() == 0 {
		return fmt.Errorf("init segment %q missing or empty", m[1])
	}
	segs := 0
	for _, l := range strings.Split(text, "\n") {
		l = strings.TrimSpace(l)
		if l == "" || strings.HasPrefix(l, "#") {
			continue
		}
		segs++
		if st, err := os.Stat(filepath.Join(dir, filepath.FromSlash(l))); err != nil || st.Size() == 0 {
			return fmt.Errorf("segment %q missing or empty", l)
		}
	}
	if segs == 0 {
		return fmt.Errorf("playlist has no segments")
	}
	if !strings.Contains(text, "#EXT-X-ENDLIST") {
		return fmt.Errorf("playlist is not finished (no #EXT-X-ENDLIST)")
	}
	return nil
}
