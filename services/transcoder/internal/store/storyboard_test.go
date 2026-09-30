package store_test

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/luantpbk/winkey/libs/go/testkit"
	"github.com/luantpbk/winkey/services/transcoder/internal/job"
	"github.com/luantpbk/winkey/services/transcoder/internal/media"
	"github.com/luantpbk/winkey/services/transcoder/internal/store"
)

// readySchema compiles envelope.schema.json and video.ready.schema.json of the contracts.
func readySchema(t *testing.T) *jsonschema.Schema {
	t.Helper()
	c := jsonschema.NewCompiler()
	c.DefaultDraft(jsonschema.Draft2020)
	dir := filepath.Join(testkit.RepoRoot(t), "contracts", "events")
	for _, f := range []string{"envelope.schema.json", "video.ready.schema.json"} {
		raw, err := os.ReadFile(filepath.Join(dir, f))
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
	s, err := c.Compile("https://winkey.vn/contracts/events/video.ready.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// The storyboard key goes into media.videos in the SAME UPDATE that makes the row READY, and into
// video.ready (a string, or an explicit null); the event validates against its JSON Schema.
func TestCompleteStoresTheStoryboardKeyWithTheReadyRow(t *testing.T) {
	pg := testkit.StartPostgres(t)
	ctx := context.Background()
	st := &store.Postgres{Pool: pg.Pool}
	schema := readySchema(t)

	for _, tc := range []struct {
		name string
		key  string // "" = no storyboard
	}{{"with storyboard", "storyboard/storyboard.vtt"}, {"without storyboard", ""}} {
		vid, owner := seed(t, pg, "UPLOADED")
		b, err := st.BeginJob(ctx, vid, "x264", "w")
		if err != nil {
			t.Fatal(err)
		}
		rs := media.Select(1280, 720)
		prefix := "v/" + vid.String() + "/a1/"
		res := job.ReadyResult{
			VideoID: vid, OwnerID: owner, JobID: b.JobID, Attempt: 1, Encoder: "x264", DurationMs: 12000,
			Width: 1280, Height: 720, MasterKey: prefix + "hls/master.m3u8", ThumbKey: prefix + "thumb/poster.jpg",
			Renditions: rs,
		}
		if tc.key != "" {
			res.StoryboardKey = prefix + tc.key
		}
		for _, r := range rs {
			res.PlaylistKeys = append(res.PlaylistKeys, prefix+"hls/"+r.Name+"/index.m3u8")
		}
		if ok, err := st.Complete(ctx, res); err != nil || !ok {
			t.Fatalf("%s: complete: %v %v", tc.name, ok, err)
		}

		var status string
		var key *string
		if err := pg.Pool.QueryRow(ctx, `SELECT status::text, storyboard_key FROM media.videos WHERE id=$1`, vid).Scan(&status, &key); err != nil {
			t.Fatal(err)
		}
		if status != "READY" || (tc.key == "") != (key == nil) || (key != nil && *key != res.StoryboardKey) {
			t.Fatalf("%s: status=%s storyboard_key=%v", tc.name, status, key)
		}

		var payload []byte
		if err := pg.Pool.QueryRow(ctx, `SELECT payload FROM media.outbox WHERE subject='video.ready' AND payload->'data'->>'video_id' = $1`, vid.String()).Scan(&payload); err != nil {
			t.Fatal(err)
		}
		inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(payload))
		if err != nil {
			t.Fatal(err)
		}
		if err := schema.Validate(inst); err != nil {
			t.Fatalf("%s: video.ready does not match its schema: %v\n%s", tc.name, err, payload)
		}
		var env struct {
			Data map[string]any `json:"data"`
		}
		_ = json.Unmarshal(payload, &env)
		got, present := env.Data["storyboard_key"]
		switch {
		case !present:
			t.Fatalf("%s: storyboard_key must be present (null when there is none): %s", tc.name, payload)
		case tc.key == "" && got != nil, tc.key != "" && got != res.StoryboardKey:
			t.Fatalf("%s: storyboard_key = %v", tc.name, got)
		}
	}
}
