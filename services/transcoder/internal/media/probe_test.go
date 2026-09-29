package media

import (
	"errors"
	"strings"
	"testing"
)

func probeJSON(video, audio, format string) []byte {
	streams := []string{}
	if video != "" {
		streams = append(streams, video)
	}
	if audio != "" {
		streams = append(streams, audio)
	}
	return []byte(`{"streams":[` + strings.Join(streams, ",") + `],"format":{` + format + `}}`)
}

const (
	v1080 = `{"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"pix_fmt":"yuv420p",
		"avg_frame_rate":"30000/1001","r_frame_rate":"30000/1001","sample_aspect_ratio":"1:1","disposition":{"attached_pic":0}}`
	aac = `{"codec_type":"audio","codec_name":"aac"}`
	dur = `"duration":"30.000000"`
)

func TestParseProbeLandscape(t *testing.T) {
	info, err := ParseProbe(probeJSON(v1080, aac, dur))
	if err != nil {
		t.Fatal(err)
	}
	if info.DisplayW != 1920 || info.DisplayH != 1080 || info.DurationSec != 30 || !info.HasAudio ||
		info.FPS != "30000/1001" || info.BitDepth != 8 || info.Rotation != 0 {
		t.Fatalf("%+v", info)
	}
}

func TestParseProbePortraitSource(t *testing.T) {
	v := `{"codec_type":"video","width":1080,"height":1920,"pix_fmt":"yuv420p","avg_frame_rate":"30/1","disposition":{}}`
	info, err := ParseProbe(probeJSON(v, aac, dur))
	if err != nil || info.DisplayW != 1080 || info.DisplayH != 1920 || info.FPS != "30" {
		t.Fatalf("%+v %v", info, err)
	}
}

func TestParseProbeNoAudio(t *testing.T) {
	info, err := ParseProbe(probeJSON(v1080, "", dur))
	if err != nil || info.HasAudio {
		t.Fatalf("%+v %v", info, err)
	}
}

func TestParseProbeTenBit(t *testing.T) {
	v := `{"codec_type":"video","codec_name":"hevc","width":3840,"height":2160,"pix_fmt":"yuv420p10le",
		"bits_per_raw_sample":"10","avg_frame_rate":"24/1","disposition":{}}`
	info, err := ParseProbe(probeJSON(v, aac, dur))
	if err != nil || info.BitDepth != 10 || info.PixFmt != "yuv420p10le" || info.VideoCodec != "hevc" {
		t.Fatalf("%+v %v", info, err)
	}
	// Without bits_per_raw_sample the pixel format decides.
	v = strings.Replace(v, `"bits_per_raw_sample":"10",`, "", 1)
	if info, _ = ParseProbe(probeJSON(v, aac, dur)); info.BitDepth != 10 {
		t.Fatalf("bit depth from pix_fmt: %+v", info)
	}
}

func TestParseProbeRotation(t *testing.T) {
	for name, tc := range map[string]struct {
		extra     string
		w, h, rot int
	}{
		"side data -90":  {`,"side_data_list":[{"side_data_type":"Display Matrix","rotation":-90}]`, 1080, 1920, 270},
		"side data 90":   {`,"side_data_list":[{"rotation":90}]`, 1080, 1920, 90},
		"legacy tag":     {`,"tags":{"rotate":"90"}`, 1080, 1920, 90},
		"180 keeps dims": {`,"side_data_list":[{"rotation":180}]`, 1920, 1080, 180},
		"none":           {``, 1920, 1080, 0},
	} {
		v := `{"codec_type":"video","width":1920,"height":1080,"pix_fmt":"yuv420p","avg_frame_rate":"30/1","disposition":{}` + tc.extra + `}`
		info, err := ParseProbe(probeJSON(v, aac, dur))
		if err != nil || info.DisplayW != tc.w || info.DisplayH != tc.h || info.Rotation != tc.rot {
			t.Errorf("%s: %+v %v", name, info, err)
		}
	}
}

func TestParseProbeAnamorphic(t *testing.T) {
	v := `{"codec_type":"video","width":1440,"height":1080,"pix_fmt":"yuv420p","sample_aspect_ratio":"4:3","avg_frame_rate":"25/1","disposition":{}}`
	info, err := ParseProbe(probeJSON(v, aac, dur))
	if err != nil || info.DisplayW != 1920 || info.DisplayH != 1080 {
		t.Fatalf("%+v %v", info, err)
	}
}

func TestFPSSelection(t *testing.T) {
	for avg, want := range map[string]string{
		"30000/1001": "30000/1001", "25/1": "25", "120/1": "60", "0/0": "30", "": "30", "60/1": "60",
	} {
		if got := chooseFPS(avg, ""); got != want {
			t.Errorf("avg %q: got %q want %q", avg, got, want)
		}
	}
	if got := chooseFPS("0/0", "24000/1001"); got != "24000/1001" {
		t.Errorf("fallback to r_frame_rate: %q", got)
	}
}

func TestParseProbeSkipsCoverArt(t *testing.T) {
	cover := `{"codec_type":"video","codec_name":"mjpeg","width":500,"height":500,"disposition":{"attached_pic":1}}`
	info, err := ParseProbe(probeJSON(cover+","+v1080, aac, dur))
	if err != nil || info.DisplayW != 1920 {
		t.Fatalf("%+v %v", info, err)
	}
}

func TestParseProbeRejects(t *testing.T) {
	huge := `{"codec_type":"video","width":15360,"height":8640,"pix_fmt":"yuv420p","avg_frame_rate":"30/1","disposition":{}}`
	for name, data := range map[string][]byte{
		"not json":      []byte("garbage"),
		"no streams":    probeJSON("", "", dur),
		"audio only":    probeJSON("", aac, dur),
		"no duration":   probeJSON(v1080, aac, `"duration":"N/A"`),
		"zero duration": probeJSON(v1080, aac, `"duration":"0.000000"`),
		"over 12 hours": probeJSON(v1080, aac, `"duration":"43201"`),
		"8K exceeded":   probeJSON(huge, aac, dur),
		"zero dims":     probeJSON(`{"codec_type":"video","width":0,"height":0,"disposition":{}}`, aac, dur),
	} {
		_, err := ParseProbe(data)
		var ii *InvalidInputError
		if !errors.As(err, &ii) {
			t.Errorf("%s: want InvalidInputError, got %v", name, err)
		}
	}
	// Boundaries that must still pass.
	if _, err := ParseProbe(probeJSON(v1080, aac, `"duration":"43200"`)); err != nil {
		t.Errorf("exactly 12h must pass: %v", err)
	}
	ok8k := `{"codec_type":"video","width":7680,"height":4320,"pix_fmt":"yuv420p","avg_frame_rate":"30/1","disposition":{}}`
	if _, err := ParseProbe(probeJSON(ok8k, aac, dur)); err != nil {
		t.Errorf("8K must pass: %v", err)
	}
}
