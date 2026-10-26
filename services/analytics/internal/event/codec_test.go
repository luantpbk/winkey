package event

import (
	"testing"
)

func TestDecodeCodecFields(t *testing.T) {
	for _, codec := range []string{"h264", "av1"} {
		for _, capable := range []string{"true", "false"} {
			t.Run(codec+"/"+capable, func(t *testing.T) {
				r, result := Decode(msg(map[string]string{"codec": `"` + codec + `"`, "av1_capable": capable}))
				if result != OK || r.Codec == nil || *r.Codec != codec || r.AV1Capable == nil || *r.AV1Capable != (capable == "true") {
					t.Fatal("valid codec fields were not preserved")
				}
			})
		}
	}
	for _, fields := range []map[string]string{nil, {"codec": "null", "av1_capable": "null"}} {
		r, result := Decode(msg(fields))
		if result != OK || r.Codec != nil || r.AV1Capable != nil {
			t.Fatal("old-client or explicit-null codec fields did not remain null")
		}
	}
	for field, values := range map[string][]string{
		"codec":       {`""`, `"hevc"`, `"AV1"`, `"vp9"`, `42`, `true`, `[]`, `{}`},
		"av1_capable": {`"true"`, `1`, `0`, `[]`, `{}`},
	} {
		for _, value := range values {
			t.Run(field+"/"+value, func(t *testing.T) {
				if _, result := Decode(msg(map[string]string{field: value})); result != Malformed {
					t.Fatal("invalid codec field was accepted")
				}
			})
		}
	}
}
