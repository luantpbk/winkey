package hlsmaster

import (
	"strings"
	"testing"
)

// What FFmpeg's hls muxer writes for two renditions (fMP4, muxed audio).
const ffmpegMaster = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-STREAM-INF:BANDWIDTH=1210000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2"
360p/index.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=5300000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
1080p/index.m3u8
`

const (
	vid       = "v/0190d3a2-7b1c-7a3e-9a52-3f6d5b8c1e44"
	masterKey = vid + "/a1/hls/master.m3u8"
	newKey    = vid + "/a1/hls/master-0190d3a2-7b1c-7a3e-9a52-000000000001.m3u8"
)

func TestWithAddsGroupAfterTheHeader(t *testing.T) {
	got, err := With([]byte(ffmpegMaster), masterKey, newKey, "Âm thanh gốc", []Track{
		{ID: "t1", Lang: "vi", Label: "Thuyết minh", Kind: "voiceover", Default: true, PlaylistKey: vid + "/a2/audio/t1/index.m3u8"},
		{ID: "t2", Lang: "en", Label: `Eng "dub"`, Kind: "dub", PlaylistKey: vid + "/a1/hls/audio/t2/index.m3u8"},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Âm thanh gốc",DEFAULT=NO,AUTOSELECT=YES
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="vi",NAME="Thuyết minh",DEFAULT=YES,AUTOSELECT=YES,URI="../../a2/audio/t1/index.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="en",NAME="Eng 'dub'",DEFAULT=NO,AUTOSELECT=YES,URI="audio/t2/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1210000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2",AUDIO="aud"
360p/index.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=5300000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aud"
1080p/index.m3u8
`
	if string(got) != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}

	// Idempotent on its own output, and removing every track gives the plain master back.
	again, err := With(got, newKey, masterKey, "Âm thanh gốc", []Track{
		{ID: "t1", Lang: "vi", Label: "Thuyết minh", Kind: "voiceover", Default: true, PlaylistKey: vid + "/a2/audio/t1/index.m3u8"},
		{ID: "t2", Lang: "en", Label: `Eng "dub"`, Kind: "dub", PlaylistKey: vid + "/a1/hls/audio/t2/index.m3u8"},
	})
	if err != nil || string(again) != want {
		t.Fatalf("not idempotent (%v):\n%s", err, again)
	}
	plain, err := With(got, newKey, masterKey, "Âm thanh gốc", nil)
	if err != nil || string(plain) != ffmpegMaster {
		t.Fatalf("removing the tracks (%v):\n%s", err, plain)
	}
}

func TestGroupDefaults(t *testing.T) {
	cases := []struct {
		name    string
		tracks  []Track
		wantIDs []string // "" is the muxed original
		wantDef int
	}{
		{"no tracks", nil, nil, -1},
		{"no default: the muxed original", []Track{{ID: "a", Kind: "dub"}}, []string{"", "a"}, 0},
		{"marked default wins", []Track{{ID: "a", Kind: "dub"}, {ID: "b", Kind: "dub", Default: true}}, []string{"", "a", "b"}, 2},
		{"an extra original replaces the muxed one and is the default", []Track{{ID: "a", Kind: "dub"}, {ID: "o", Kind: "original"}}, []string{"a", "o"}, 1},
		{"only the first of two defaults", []Track{{ID: "a", Kind: "dub", Default: true}, {ID: "b", Kind: "dub", Default: true}}, []string{"", "a", "b"}, 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			g := Group("Gốc", c.tracks)
			if len(g) != len(c.wantIDs) {
				t.Fatalf("group = %+v", g)
			}
			defs := 0
			for i, r := range g {
				if r.ID != c.wantIDs[i] || r.Original != (c.wantIDs[i] == "") {
					t.Errorf("[%d] = %+v, want id %q", i, r, c.wantIDs[i])
				}
				if r.Default {
					defs++
					if i != c.wantDef {
						t.Errorf("default at %d, want %d", i, c.wantDef)
					}
				}
			}
			if len(g) > 0 && defs != 1 {
				t.Errorf("%d defaults", defs)
			}
		})
	}
}

func TestWithRefusesBadInput(t *testing.T) {
	tr := []Track{{ID: "a", Lang: "vi", Label: "x", Kind: "dub", PlaylistKey: vid + "/a2/audio/a/index.m3u8"}}
	for name, f := range map[string]func() error{
		"other directory": func() error { _, err := With([]byte(ffmpegMaster), masterKey, vid+"/m.m3u8", "o", tr); return err },
		"not a playlist":  func() error { _, err := With([]byte("<html>"), masterKey, newKey, "o", tr); return err },
		"no variants":     func() error { _, err := With([]byte("#EXTM3U\n"), masterKey, newKey, "o", tr); return err },
		"key with ..": func() error {
			_, err := With([]byte(ffmpegMaster), masterKey, newKey, "o", []Track{{Lang: "vi", Kind: "dub", PlaylistKey: vid + "/../x"}})
			return err
		},
	} {
		if err := f(); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
}

func TestWithHandlesCRLF(t *testing.T) {
	got, err := With([]byte(strings.ReplaceAll(ffmpegMaster, "\n", "\r\n")), masterKey, newKey, "o", nil)
	if err != nil || string(got) != ffmpegMaster {
		t.Fatalf("%v\n%q", err, got)
	}
}

func TestNewKey(t *testing.T) {
	if got := NewKey(masterKey, "x1"); got != vid+"/a1/hls/master-x1.m3u8" {
		t.Fatal(got)
	}
	if got := NewKey(NewKey(masterKey, "x1"), "x2"); got != vid+"/a1/hls/master-x2.m3u8" {
		t.Fatal(got)
	}
}

// What FFmpeg writes for video-only variants and one audio rendition (var_stream_map with agroup:aud),
// including the audio-only variant it adds to the ladder.
const ffmpegSeparateMaster = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_aud",NAME="audio_2",DEFAULT=YES,URI="audio/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=5300000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="group_aud"
1080p/index.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=1210000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2",AUDIO="group_aud"
360p/index.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=140800,CODECS="mp4a.40.2",AUDIO="group_aud"
audio/index.m3u8
`

// The separate layout (ADR-042 addendum 2026-10-17): the original is a rendition with a URI, FFmpeg's
// audio-only variant is dropped, and the group stays with the original alone when there is no track.
func TestWithSeparateOriginalAudio(t *testing.T) {
	plain, err := With([]byte(ffmpegSeparateMaster), masterKey, masterKey, "Âm thanh gốc", nil)
	if err != nil {
		t.Fatal(err)
	}
	wantPlain := `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Âm thanh gốc",DEFAULT=YES,AUTOSELECT=YES,URI="audio/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=5300000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aud"
1080p/index.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=1210000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2",AUDIO="aud"
360p/index.m3u8
`
	if string(plain) != wantPlain {
		t.Fatalf("plain:\n%s\nwant:\n%s", plain, wantPlain)
	}

	tracks := []Track{{ID: "t1", Lang: "vi", Label: "Thuyết minh", Kind: "voiceover", Default: true, PlaylistKey: vid + "/audio/t1/index.m3u8"}}
	got, err := With(plain, masterKey, newKey, "Âm thanh gốc", tracks)
	if err != nil {
		t.Fatal(err)
	}
	want := `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Âm thanh gốc",DEFAULT=NO,AUTOSELECT=YES,URI="audio/index.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="vi",NAME="Thuyết minh",DEFAULT=YES,AUTOSELECT=YES,URI="../../audio/t1/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=5300000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aud"
1080p/index.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=1210000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2",AUDIO="aud"
360p/index.m3u8
`
	if string(got) != want {
		t.Fatalf("with a track:\n%s\nwant:\n%s", got, want)
	}
	// The raw FFmpeg master gives the same result, and removing the track keeps the original alone.
	if raw, err := With([]byte(ffmpegSeparateMaster), masterKey, newKey, "Âm thanh gốc", tracks); err != nil || string(raw) != want {
		t.Fatalf("from the raw master (%v):\n%s", err, raw)
	}
	if back, err := With(got, newKey, masterKey, "Âm thanh gốc", nil); err != nil || string(back) != wantPlain {
		t.Fatalf("removing the track (%v):\n%s", err, back)
	}
	// An uploaded track of kind original replaces the video's own audio in the group.
	repl, err := With(plain, masterKey, newKey, "Âm thanh gốc", []Track{{ID: "o", Lang: "zh", Label: "Gốc (zh)", Kind: "original", PlaylistKey: vid + "/audio/o/index.m3u8"}})
	if err != nil || strings.Contains(string(repl), `URI="audio/index.m3u8"`) || !strings.Contains(string(repl), `URI="../../audio/o/index.m3u8"`) {
		t.Fatalf("original replaced (%v):\n%s", err, repl)
	}
}
