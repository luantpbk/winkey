// Package hlsmaster rewrites the alternate audio group of an HLS master playlist (task MUX1, ADR-042).
//
// The video variants written by the transcoder keep their muxed original audio. When a video has extra
// audio tracks that are READY, the master gets one `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud"` group: the
// original first, WITHOUT a URI (its audio is in the variants, RFC 8216 §4.3.4.1), then one rendition per
// extra track pointing at that track's own playlist, and every `#EXT-X-STREAM-INF` names the group. With
// no extra track the group is removed, so the master is the plain one again.
//
// The transcoder (a track becomes READY) and video-svc (a track is renamed, made default or deleted) both
// call With, each under a row lock on the video, and store the result under a NEW key next to the old
// master: cached copies of a master never change, and the variants' relative URIs stay valid.
package hlsmaster

import (
	"errors"
	"fmt"
	"path"
	"regexp"
	"strings"
)

// GroupID is the audio group the variants refer to.
const GroupID = "aud"

// OriginalLabel is the name of the muxed original in the master and in Playback.audio_tracks.
const OriginalLabel = "Âm thanh gốc"

// ContentType is the media type of playlists in the media bucket.
const ContentType = "application/vnd.apple.mpegurl"

// MaxSize bounds a master read back from the bucket (a few variants and at most 9 renditions).
const MaxSize = 64 << 10

// NewKey is the key of a rewritten master next to masterKey; id is a fresh UUIDv7.
func NewKey(masterKey, id string) string {
	return path.Dir(masterKey) + "/master-" + id + ".m3u8"
}

// OriginalLang is the language of the muxed original: BCP 47 "undetermined", because the upload API
// does not carry it. The master omits LANGUAGE for it.
const OriginalLang = "und"

// Track is one extra audio track that is READY.
type Track struct {
	ID          string
	Lang        string
	Label       string
	Kind        string // original, dub, voiceover, commentary
	Default     bool
	PlaylistKey string // object key of the track's media playlist
}

// Rendition is one entry of the audio group in master order; Original is true for the muxed audio.
type Rendition struct {
	Track
	Original bool
}

// Group returns the audio renditions a master built from tracks lists, in order: the muxed original
// first unless an extra track of kind original replaces it, then the tracks as given. Exactly one is
// the default: the track marked Default, else the original (muxed or extra), else the first. Empty
// when tracks is empty.
func Group(originalLabel string, tracks []Track) []Rendition {
	if len(tracks) == 0 {
		return nil
	}
	var out []Rendition
	hasOriginal := false
	for _, t := range tracks {
		if t.Kind == "original" {
			hasOriginal = true
		}
	}
	if !hasOriginal {
		out = append(out, Rendition{Original: true, Track: Track{Lang: OriginalLang, Label: originalLabel, Kind: "original"}})
	}
	def := -1
	for _, t := range tracks {
		if t.Default && def == -1 {
			def = len(out)
		}
		out = append(out, Rendition{Track: t})
	}
	if def == -1 {
		def = 0
		for i, r := range out {
			if r.Kind == "original" {
				def = i
				break
			}
		}
	}
	for i := range out {
		out[i].Default = i == def
	}
	return out
}

var (
	audioMediaRe = regexp.MustCompile(`^#EXT-X-MEDIA:.*\bTYPE=AUDIO\b`)
	audioAttrRe  = regexp.MustCompile(`,AUDIO="[^"]*"`)
)

// With returns master (stored at masterKey) with its audio group replaced by the renditions of
// Group(originalLabel, tracks), for storage at newKey. newKey must be in the same directory as
// masterKey, so the variant URIs need no change; track playlists are referenced relative to it.
func With(master []byte, masterKey, newKey, originalLabel string, tracks []Track) ([]byte, error) {
	if path.Dir(masterKey) != path.Dir(newKey) {
		return nil, fmt.Errorf("hlsmaster: new key %q is not next to %q", newKey, masterKey)
	}
	text := strings.ReplaceAll(string(master), "\r\n", "\n")
	if !strings.HasPrefix(text, "#EXTM3U") {
		return nil, errors.New("hlsmaster: not a playlist (no #EXTM3U)")
	}
	group := Group(originalLabel, tracks)
	dir := path.Dir(newKey)

	var out []string
	variants := 0
	inserted := false
	for _, l := range strings.Split(strings.TrimRight(text, "\n"), "\n") {
		if audioMediaRe.MatchString(l) {
			continue // the old group; the new one is written before the first variant
		}
		if strings.HasPrefix(l, "#EXT-X-STREAM-INF:") {
			variants++
			if !inserted {
				for _, r := range group {
					line, err := mediaLine(r, dir)
					if err != nil {
						return nil, err
					}
					out = append(out, line)
				}
				inserted = true
			}
			l = audioAttrRe.ReplaceAllString(l, "")
			if len(group) > 0 {
				l += `,AUDIO="` + GroupID + `"`
			}
		}
		out = append(out, l)
	}
	if variants == 0 {
		return nil, errors.New("hlsmaster: no #EXT-X-STREAM-INF in master")
	}
	return []byte(strings.Join(out, "\n") + "\n"), nil
}

func mediaLine(r Rendition, dir string) (string, error) {
	var b strings.Builder
	b.WriteString(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="` + GroupID + `"`)
	if r.Lang != OriginalLang {
		b.WriteString(`,LANGUAGE="` + quoted(r.Lang) + `"`)
	}
	b.WriteString(`,NAME="` + quoted(r.Label) + `"`)
	if r.Default {
		b.WriteString(`,DEFAULT=YES,AUTOSELECT=YES`)
	} else {
		b.WriteString(`,DEFAULT=NO,AUTOSELECT=YES`)
	}
	if !r.Original {
		rel, err := relative(dir, r.PlaylistKey)
		if err != nil {
			return "", err
		}
		b.WriteString(`,URI="` + rel + `"`)
	}
	return b.String(), nil
}

// quoted makes s safe inside an attribute's double quotes: RFC 8216 forbids `"`, CR and LF there.
func quoted(s string) string {
	return strings.NewReplacer(`"`, "'", "\r", " ", "\n", " ").Replace(s)
}

// relative is the URI of key as seen from a playlist in dir (both object keys, no leading slash).
func relative(dir, key string) (string, error) {
	if key == "" || strings.HasPrefix(key, "/") || strings.Contains(key, "..") {
		return "", fmt.Errorf("hlsmaster: bad playlist key %q", key)
	}
	from := strings.Split(path.Clean(dir), "/")
	to := strings.Split(path.Clean(key), "/")
	i := 0
	for i < len(from) && i < len(to)-1 && from[i] == to[i] {
		i++
	}
	parts := make([]string, 0, len(from)-i+len(to)-i)
	for range from[i:] {
		parts = append(parts, "..")
	}
	parts = append(parts, to[i:]...)
	return strings.Join(parts, "/"), nil
}
