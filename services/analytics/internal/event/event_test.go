package event

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

const (
	uPlayback = "0192f5f1-aaaa-7000-8000-000000000001"
	uVideo    = "0192f5e1-0000-7000-8000-000000000010"
	uOwner    = "0192f5e0-0000-7000-8000-000000000001"
	uEvent    = "5f0c2c8e-6a51-5a7e-9d1b-2f3c4d5e6f70"
	vkey      = "3b1f0c9a8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a"
)

func repoFile(t *testing.T, rel ...string) string {
	t.Helper()
	wd, _ := os.Getwd()
	for i := 0; i < 8; i++ {
		p := filepath.Join(append([]string{wd}, rel...)...)
		if _, err := os.Stat(p); err == nil {
			return p
		}
		wd = filepath.Dir(wd)
	}
	t.Fatalf("%v not found", rel)
	return ""
}

// msg builds a message; over replaces a field of data ("" removes it, any other value is raw JSON).
func msg(over map[string]string) []byte {
	d := map[string]string{
		"playback_id": `"` + uPlayback + `"`, "video_id": `"` + uVideo + `"`, "owner_id": `"` + uOwner + `"`,
		"viewer_key": `"` + vkey + `"`, "authenticated": `true`, "kind": `"heartbeat"`, "seq": `4`,
		"received_at": `"2026-10-02T11:05:30.123Z"`, "sent_at": `"2026-10-02T11:05:29Z"`, "position_ms": `121500`,
		"watched_ms": `30000`, "rebuffer_ms": `450`, "rebuffer_count": `1`, "startup_ms": `null`, "rendition": `"720p"`,
		"bitrate_kbps": `2800`, "error_code": `null`, "client": `"web"`, "country": `null`,
	}
	for k, v := range over {
		if v == "" {
			delete(d, k)
		} else {
			d[k] = v
		}
	}
	keys := make([]string, 0, len(d))
	for k := range d {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%q:%s", k, d[k]))
	}
	return []byte(fmt.Sprintf(`{"event_id":%q,"type":"analytics.playback","version":1,"occurred_at":"2026-10-02T11:05:30Z","producer":"video-svc","data":{%s}}`, uEvent, strings.Join(parts, ",")))
}

func TestDecodeAValidMessage(t *testing.T) {
	r, res := Decode(msg(nil))
	if res != OK {
		t.Fatalf("result %v", res)
	}
	if r.EventID.String() != uEvent || r.PlaybackID.String() != uPlayback || r.VideoID.String() != uVideo || r.OwnerID.String() != uOwner ||
		r.ViewerKey != vkey || !r.Authenticated || r.Kind != "heartbeat" || r.Seq != 4 || r.PositionMs != 121500 || r.WatchedMs != 30000 ||
		r.RebufferMs != 450 || r.RebufferCount != 1 || r.StartupMs != nil || r.Rendition == nil || *r.Rendition != "720p" ||
		r.BitrateKbps == nil || *r.BitrateKbps != 2800 || r.ErrorCode != nil || r.Client != "web" || r.Country != nil {
		t.Fatalf("%+v", r)
	}
	if r.ReceivedAt.UnixMilli() != 1790939130123 || r.ReceivedAt.Location().String() != "UTC" || r.SentAt.Unix() != 1790939129 {
		t.Fatalf("times: %v %v", r.ReceivedAt, r.SentAt)
	}
	r, res = Decode(msg(map[string]string{"kind": `"start"`, "seq": `0`, "startup_ms": `820`, "error_code": `"manifestLoadError"`, "country": `"VN"`, "rendition": `null`, "bitrate_kbps": `null`}))
	if res != OK || r.StartupMs == nil || *r.StartupMs != 820 || r.ErrorCode == nil || *r.ErrorCode != "manifestLoadError" || r.Country == nil || *r.Country != "VN" || r.Rendition != nil || r.BitrateKbps != nil {
		t.Fatalf("%v %+v", res, r)
	}
	raw, err := os.ReadFile(repoFile(t, "contracts", "events", "examples", "analytics.playback.json"))
	if err != nil {
		t.Fatal(err)
	}
	if _, res := Decode(raw); res != OK {
		t.Fatalf("the contract example is %v", res)
	}
	if _, res := Decode(msg(map[string]string{"seq": `100000`, "watched_ms": `600000`, "rebuffer_ms": `600000`, "rebuffer_count": `1000`, "startup_ms": `600000`, "position_ms": `4294967295`, "bitrate_kbps": `4294967295`, "rendition": `"` + strings.Repeat("x", 16) + `"`, "error_code": `"` + strings.Repeat("e", 64) + `"`})); res != OK {
		t.Fatalf("limits: %v", res)
	}
}

func TestDecodeRejectsWhatTheSchemaRejects(t *testing.T) {
	ok := string(msg(nil))
	bad := map[string][]byte{
		"not json":            []byte(`garbage`),
		"empty":               []byte(``),
		"trailing data":       append(msg(nil), []byte(` {}`)...),
		"extra envelope key":  []byte(strings.Replace(ok, `"producer"`, `"extra":1,"producer"`, 1)),
		"no event_id":         []byte(strings.Replace(ok, `"event_id":"`+uEvent+`",`, "", 1)),
		"event_id not uuid":   []byte(strings.Replace(ok, uEvent, "nope", 1)),
		"wrong type":          []byte(strings.Replace(ok, `"analytics.playback"`, `"analytics.other"`, 1)),
		"no occurred_at":      []byte(strings.Replace(ok, `"occurred_at":"2026-10-02T11:05:30Z",`, "", 1)),
		"bad occurred_at":     []byte(strings.Replace(ok, `2026-10-02T11:05:30Z`, `yesterday`, 1)),
		"no producer":         []byte(strings.Replace(ok, `,"producer":"video-svc"`, "", 1)),
		"version 0":           []byte(strings.Replace(ok, `"version":1`, `"version":0`, 1)),
		"data null":           []byte(fmt.Sprintf(`{"event_id":%q,"type":"analytics.playback","version":1,"occurred_at":"2026-10-02T11:05:30Z","producer":"p","data":null}`, uEvent)),
		"data a string":       []byte(fmt.Sprintf(`{"event_id":%q,"type":"analytics.playback","version":1,"occurred_at":"2026-10-02T11:05:30Z","producer":"p","data":"x"}`, uEvent)),
		"extra data key":      msg(map[string]string{"user_agent": `"x"`}),
		"no playback_id":      msg(map[string]string{"playback_id": ""}),
		"playback_id no dash": msg(map[string]string{"playback_id": `"` + strings.ReplaceAll(uPlayback, "-", "") + `"`}),
		"video_id number":     msg(map[string]string{"video_id": `5`}),
		"no owner_id":         msg(map[string]string{"owner_id": ""}),
		"viewer_key short":    msg(map[string]string{"viewer_key": `"abc"`}),
		"viewer_key upper":    msg(map[string]string{"viewer_key": `"` + strings.ToUpper(vkey) + `"`}),
		"no viewer_key":       msg(map[string]string{"viewer_key": ""}),
		"no authenticated":    msg(map[string]string{"authenticated": ""}),
		"authenticated str":   msg(map[string]string{"authenticated": `"yes"`}),
		"kind unknown":        msg(map[string]string{"kind": `"pause"`}),
		"no kind":             msg(map[string]string{"kind": ""}),
		"seq negative":        msg(map[string]string{"seq": `-1`}),
		"seq 100001":          msg(map[string]string{"seq": `100001`}),
		"seq fractional":      msg(map[string]string{"seq": `1.5`}),
		"seq string":          msg(map[string]string{"seq": `"1"`}),
		"no seq":              msg(map[string]string{"seq": ""}),
		"no received_at":      msg(map[string]string{"received_at": ""}),
		"bad received_at":     msg(map[string]string{"received_at": `"2026-10-02"`}),
		"bad sent_at":         msg(map[string]string{"sent_at": `"x"`}),
		"position negative":   msg(map[string]string{"position_ms": `-1`}),
		"position too big":    msg(map[string]string{"position_ms": `4294967296`}),
		"watched 600001":      msg(map[string]string{"watched_ms": `600001`}),
		"watched negative":    msg(map[string]string{"watched_ms": `-1`}),
		"no watched":          msg(map[string]string{"watched_ms": ""}),
		"rebuffer_ms 600001":  msg(map[string]string{"rebuffer_ms": `600001`}),
		"rebuffer_count 1001": msg(map[string]string{"rebuffer_count": `1001`}),
		"startup 600001":      msg(map[string]string{"startup_ms": `600001`}),
		"rendition too long":  msg(map[string]string{"rendition": `"` + strings.Repeat("x", 17) + `"`}),
		"bitrate negative":    msg(map[string]string{"bitrate_kbps": `-1`}),
		"error_code too long": msg(map[string]string{"error_code": `"` + strings.Repeat("e", 65) + `"`}),
		"client unknown":      msg(map[string]string{"client": `"tv"`}),
		"no client":           msg(map[string]string{"client": ""}),
		"country lower":       msg(map[string]string{"country": `"vn"`}),
		"country 3 letters":   msg(map[string]string{"country": `"VNM"`}),
	}
	for name, p := range bad {
		if _, res := Decode(p); res != Malformed {
			t.Errorf("%s: %v", name, res)
		}
	}
	if _, res := Decode([]byte(strings.Replace(ok, `"version":1`, `"version":2`, 1))); res != UnknownVersion {
		t.Errorf("version 2: %v", res)
	}
	if _, res := Decode([]byte(`{"event_id":"nope","type":"analytics.playback","version":2}`)); res != Malformed {
		t.Errorf("bad envelope of version 2: %v", res)
	}
}

// The hand-written validation and the JSON Schema of the contract agree.
func TestDecodeAgreesWithTheContractSchema(t *testing.T) {
	c := jsonschema.NewCompiler()
	c.DefaultDraft(jsonschema.Draft2020)
	c.AssertFormat()
	for _, f := range []string{"envelope.schema.json", "analytics.playback.schema.json"} {
		raw, err := os.ReadFile(repoFile(t, "contracts", "events", f))
		if err != nil {
			t.Fatal(err)
		}
		doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		if err := c.AddResource("https://winkey.vn/contracts/events/"+f, doc); err != nil {
			t.Fatal(err)
		}
	}
	schema, err := c.Compile("https://winkey.vn/contracts/events/analytics.playback.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string][]byte{
		"valid": msg(nil), "start": msg(map[string]string{"kind": `"start"`, "startup_ms": `820`}),
		"reco for_you":               msg(map[string]string{"surface": `"for_you"`, "reco_variant": `"reco"`}),
		"control search":             msg(map[string]string{"surface": `"search"`, "reco_variant": `"control"`}),
		"null recommendation fields": msg(map[string]string{"surface": `null`, "reco_variant": `null`}),
		"invalid surface":            msg(map[string]string{"surface": `"home"`}),
		"surface wrong type":         msg(map[string]string{"surface": `12`}),
		"invalid variant":            msg(map[string]string{"reco_variant": `"treatment"`}),
		"variant wrong type":         msg(map[string]string{"reco_variant": `true`}),
		"extra data key":             msg(map[string]string{"x": `1`}), "viewer_key short": msg(map[string]string{"viewer_key": `"abc"`}),
		"kind unknown": msg(map[string]string{"kind": `"pause"`}), "seq 100001": msg(map[string]string{"seq": `100001`}),
		"watched 600001": msg(map[string]string{"watched_ms": `600001`}), "no owner_id": msg(map[string]string{"owner_id": ""}),
		"country lower": msg(map[string]string{"country": `"vn"`}), "country ok": msg(map[string]string{"country": `"VN"`}),
		"client unknown": msg(map[string]string{"client": `"tv"`}), "bad received_at": msg(map[string]string{"received_at": `"2026-10-02"`}),
		"rendition too long": msg(map[string]string{"rendition": `"` + strings.Repeat("x", 17) + `"`}),
		"negative position":  msg(map[string]string{"position_ms": `-1`}), "no authenticated": msg(map[string]string{"authenticated": ""}),
	}
	for name, p := range cases {
		inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(p))
		schemaOK := err == nil && schema.Validate(inst) == nil
		_, res := Decode(p)
		if (res == OK) != schemaOK {
			t.Errorf("%s: schema valid=%v, Decode=%v\n%s", name, schemaOK, res, p)
		}
	}
}
