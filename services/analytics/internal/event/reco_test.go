package event

import (
	"strconv"
	"testing"
)

func TestDecodeRecommendationFields(t *testing.T) {
	for _, surface := range []string{"for_you", "latest", "trending", "up_next", "search", "subscriptions", "channel", "playlist", "other"} {
		for _, arm := range []string{"reco", "control"} {
			t.Run(surface+"/"+arm, func(t *testing.T) {
				r, result := Decode(msg(map[string]string{"surface": strconv.Quote(surface), "reco_variant": strconv.Quote(arm)}))
				if result != OK || r.Surface == nil || *r.Surface != surface || r.RecoVariant == nil || *r.RecoVariant != arm {
					t.Fatal("valid recommendation fields were not preserved")
				}
			})
		}
	}
	for _, fields := range []map[string]string{nil, {"surface": "null", "reco_variant": "null"}} {
		r, result := Decode(msg(fields))
		if result != OK || r.Surface != nil || r.RecoVariant != nil {
			t.Fatal("old-client or explicit-null fields did not remain null")
		}
	}
	for _, field := range []string{"surface", "reco_variant"} {
		for _, value := range []string{`""`, `"invalid"`, `"RECO"`, `"for-you"`, `42`, `true`, `[]`, `{}`} {
			t.Run(field+"/"+value, func(t *testing.T) {
				if _, result := Decode(msg(map[string]string{field: value})); result != Malformed {
					t.Fatal("invalid recommendation field was accepted")
				}
			})
		}
	}
	if _, result := Decode(msg(map[string]string{"surface_extra": `"for_you"`})); result != Malformed {
		t.Fatal("unknown fields must remain malformed")
	}
}
