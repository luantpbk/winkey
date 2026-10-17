package media

import (
	"strings"
	"testing"
)

func TestAV1Codec(t *testing.T) {
	for _, tc := range []struct {
		info Info
		want string
	}{
		{Info{VideoCodec: "av1", VideoProfile: "Main", VideoLevel: 8, BitDepth: 8}, "av01.0.08M.08"},
		{Info{VideoCodec: "av1", VideoProfile: "Main", VideoLevel: 5, BitDepth: 8}, "av01.0.05M.08"},
		{Info{VideoCodec: "av1", VideoProfile: "Main", VideoLevel: 12, BitDepth: 10}, "av01.0.12M.10"},
		{Info{VideoCodec: "av1", VideoProfile: "High", VideoLevel: 9, BitDepth: 8}, "av01.1.09M.08"},
	} {
		if got, err := AV1Codec(tc.info); err != nil || got != tc.want {
			t.Errorf("%+v: %q %v, want %q", tc.info, got, err, tc.want)
		}
	}
	for _, bad := range []Info{
		{VideoCodec: "h264", VideoProfile: "High", VideoLevel: 40, BitDepth: 8},
		{VideoCodec: "av1", VideoProfile: "", VideoLevel: 8, BitDepth: 8},
		{VideoCodec: "av1", VideoProfile: "Main", VideoLevel: -99, BitDepth: 8},
		{VideoCodec: "av1", VideoProfile: "Main", VideoLevel: 8, BitDepth: 9},
	} {
		if got, err := AV1Codec(bad); err == nil {
			t.Errorf("%+v: %q, want an error", bad, got)
		}
	}
}

// The master FFmpeg 8 writes for an AV1 ladder (gpu-01, 2026-10-17): no CODECS at all.
const av1MasterNoCodecs = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n" +
	"#EXT-X-STREAM-INF:BANDWIDTH=5063982,AVERAGE-BANDWIDTH=3100000,RESOLUTION=1920x1080\n1080p/index.m3u8\n\n" +
	"#EXT-X-STREAM-INF:BANDWIDTH=2900000,RESOLUTION=1280x720\n720p/index.m3u8\n"

func TestSetMasterCodecs(t *testing.T) {
	out, err := SetMasterCodecs([]byte(av1MasterNoCodecs), map[string]string{
		"1080p": "av01.0.08M.08,mp4a.40.2", "720p": "av01.0.05M.08,mp4a.40.2",
	})
	if err != nil {
		t.Fatal(err)
	}
	vars := ParseMaster(string(out))
	if len(vars) != 2 || vars[0].Codecs != "av01.0.08M.08,mp4a.40.2" || vars[1].Codecs != "av01.0.05M.08,mp4a.40.2" ||
		vars[0].Bandwidth != 5063982 || vars[0].Resolution != "1920x1080" || vars[1].URI != "720p/index.m3u8" {
		t.Fatalf("variants %+v\n%s", vars, out)
	}
	if !strings.Contains(string(out), "AVERAGE-BANDWIDTH=3100000,RESOLUTION=1920x1080,CODECS=") {
		t.Fatalf("other attributes changed:\n%s", out)
	}

	// A CODECS FFmpeg did write is replaced, not duplicated.
	again, err := SetMasterCodecs(out, map[string]string{"1080p": "av01.0.09M.08", "720p": "av01.0.05M.08"})
	if err != nil || strings.Count(string(again), "CODECS=") != 2 || ParseMaster(string(again))[0].Codecs != "av01.0.09M.08" {
		t.Fatalf("replace: %v\n%s", err, again)
	}

	// Every variant needs an entry.
	if _, err := SetMasterCodecs([]byte(av1MasterNoCodecs), map[string]string{"1080p": "av01.0.08M.08"}); err == nil {
		t.Fatal("a variant without codecs was accepted")
	}
	if _, err := SetMasterCodecs([]byte("#EXTM3U\n"), nil); err == nil {
		t.Fatal("a master without variants was accepted")
	}
}
