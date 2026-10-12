package job

import (
	"testing"

	"github.com/luantpbk/winkey/services/transcoder/internal/media"
)

func TestConfigRateControlForSummaryLog(t *testing.T) {
	for _, tc := range []struct {
		cfg     Config
		encoder string
		mode    string
		level   int
	}{
		{Config{}, media.EncoderNVENC, media.RateControlABR, 0},
		{Config{RateControl: media.RateControlABR, NVENCCQ: 27}, media.EncoderNVENC, media.RateControlABR, 0},
		{Config{RateControl: media.RateControlCappedCRF, NVENCCQ: 27, X264CRF: 21}, media.EncoderNVENC, media.RateControlCappedCRF, 27},
		// An NVENC job that fell back to x264 reports the CRF that actually ran.
		{Config{RateControl: media.RateControlCappedCRF, NVENCCQ: 27, X264CRF: 21}, media.EncoderX264, media.RateControlCappedCRF, 21},
		{Config{RateControl: media.RateControlCappedCRF}, media.EncoderNVENC, media.RateControlCappedCRF, media.DefaultNVENCCQ},
	} {
		mode, level := tc.cfg.rateControl(tc.encoder)
		if mode != tc.mode || level != tc.level {
			t.Errorf("%+v %s: got %s/%d, want %s/%d", tc.cfg, tc.encoder, mode, level, tc.mode, tc.level)
		}
	}
}
