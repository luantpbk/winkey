package media

import (
	"errors"
	"strings"
	"testing"
)

func TestParseAudioProbe(t *testing.T) {
	flac := `{"streams":[{"codec_type":"video","codec_name":"mjpeg","disposition":{"attached_pic":1}},
		{"codec_type":"audio","codec_name":"flac","channels":6,"sample_rate":"48000","duration":"5400.020"}],
		"format":{"duration":"5400.100"}}`
	info, err := ParseAudioProbe([]byte(flac))
	if err != nil || info.Codec != "flac" || info.Channels != 6 || info.SampleRate != 48000 || info.DurationSec != 5400.02 {
		t.Fatalf("%+v %v", info, err)
	}
	// No stream duration (some WAV/Ogg muxers): the container's.
	info, err = ParseAudioProbe([]byte(`{"streams":[{"codec_type":"audio","codec_name":"pcm_s24le","channels":2,"sample_rate":"44100"}],"format":{"duration":"61.5"}}`))
	if err != nil || info.DurationSec != 61.5 {
		t.Fatalf("%+v %v", info, err)
	}
	for name, in := range map[string]string{
		"not json":    `nope`,
		"no audio":    `{"streams":[{"codec_type":"video","codec_name":"h264"}],"format":{"duration":"10"}}`,
		"no duration": `{"streams":[{"codec_type":"audio","codec_name":"aac"}],"format":{}}`,
		"too long":    `{"streams":[{"codec_type":"audio","codec_name":"aac","duration":"50000"}],"format":{}}`,
	} {
		var ie *InvalidInputError
		if _, err := ParseAudioProbe([]byte(in)); !errors.As(err, &ie) {
			t.Errorf("%s: %v, want InvalidInputError", name, err)
		}
	}
}

func TestAudioMatchesVideo(t *testing.T) {
	for _, c := range []struct {
		sec  float64
		ms   int
		want bool
	}{
		{5400.0, 5400000, true}, {5400.1, 5400000, true}, {5399.9, 5400000, true},
		{5400.101, 5400000, false}, {5399.85, 5400000, false}, {60, 5400000, false},
	} {
		if got := AudioMatchesVideo(c.sec, c.ms); got != c.want {
			t.Errorf("%v s vs %d ms: %v", c.sec, c.ms, got)
		}
	}
}

func TestBuildAudioHLSArgs(t *testing.T) {
	got := strings.Join(BuildAudioHLSArgs("/w/in.flac", "/w/out"), " ")
	for _, want := range []string{
		"-protocol_whitelist file", "-i /w/in.flac", "-map 0:a:0 -vn",
		"-c:a aac -b:a 128k -ar 48000 -ac 2", // the variants' muxed audio, so switching never changes codec
		"-hls_time 4", "-hls_segment_type fmp4", "-hls_fmp4_init_filename init.mp4",
		"-hls_segment_filename /w/out/seg_%05d.m4s", "/w/out/index.m3u8",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in %s", want, got)
		}
	}
}
