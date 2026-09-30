package store_test

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/luantpbk/winkey/libs/go/testkit"
	"github.com/luantpbk/winkey/services/transcoder/internal/job"
	"github.com/luantpbk/winkey/services/transcoder/internal/media"
	"github.com/luantpbk/winkey/services/transcoder/internal/store"
)

// Task C4-b: the UPDATE that switches the row to READY RETURNs the visibility, and video.ready
// carries it (data.visibility), so social-svc learns it without another lookup. Real PostgreSQL 17.
func TestCompleteCarriesTheVisibilityInVideoReady(t *testing.T) {
	pg := testkit.StartPostgres(t)
	ctx := context.Background()
	st := &store.Postgres{Pool: pg.Pool}
	schema := readySchema(t)

	for _, visibility := range []string{"PUBLIC", "UNLISTED", "PRIVATE"} {
		vid, owner := seed(t, pg, "UPLOADED")
		if _, err := pg.Pool.Exec(ctx, `UPDATE media.videos SET visibility = $2::media.visibility WHERE id = $1`, vid, visibility); err != nil {
			t.Fatal(err)
		}
		b, err := st.BeginJob(ctx, vid, "x264", "w")
		if err != nil {
			t.Fatal(err)
		}
		// The owner changes the visibility while the video is being transcoded: the event says what the
		// row says at the moment it becomes READY, not what it said when the job began.
		final := visibility
		if visibility == "PUBLIC" {
			final = "PRIVATE"
			if _, err := pg.Pool.Exec(ctx, `UPDATE media.videos SET visibility = 'PRIVATE' WHERE id = $1`, vid); err != nil {
				t.Fatal(err)
			}
		}
		rs := media.Select(1280, 720)
		prefix := "v/" + vid.String() + "/a1/"
		res := job.ReadyResult{
			VideoID: vid, OwnerID: owner, JobID: b.JobID, Attempt: 1, Encoder: "x264", DurationMs: 12000,
			Width: 1280, Height: 720, MasterKey: prefix + "hls/master.m3u8", ThumbKey: prefix + "thumb/poster.jpg",
			Renditions: rs,
		}
		for _, r := range rs {
			res.PlaylistKeys = append(res.PlaylistKeys, prefix+"hls/"+r.Name+"/index.m3u8")
		}
		if ok, err := st.Complete(ctx, res); err != nil || !ok {
			t.Fatalf("%s: complete: %v %v", visibility, ok, err)
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
			t.Fatalf("%s: video.ready does not match its schema: %v\n%s", visibility, err, payload)
		}
		var env struct {
			Data struct {
				Visibility    string  `json:"visibility"`
				StoryboardKey *string `json:"storyboard_key"`
			} `json:"data"`
		}
		if err := json.Unmarshal(payload, &env); err != nil {
			t.Fatal(err)
		}
		if env.Data.Visibility != final {
			t.Fatalf("video.ready.visibility = %q, want %q\n%s", env.Data.Visibility, final, payload)
		}
	}
}

// A video that is no longer PROCESSING (deleted, or already READY) writes nothing, as before.
func TestCompleteOfAVideoThatIsNotProcessingWritesNoEvent(t *testing.T) {
	pg := testkit.StartPostgres(t)
	ctx := context.Background()
	st := &store.Postgres{Pool: pg.Pool}
	vid, owner := seed(t, pg, "UPLOADED")
	b, err := st.BeginJob(ctx, vid, "x264", "w")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pg.Pool.Exec(ctx, `DELETE FROM media.videos WHERE id = $1`, vid); err != nil {
		t.Fatal(err)
	}
	rs := media.Select(1280, 720)
	res := job.ReadyResult{VideoID: vid, OwnerID: owner, JobID: b.JobID, Attempt: 1, Encoder: "x264", DurationMs: 1000,
		Width: 1280, Height: 720, MasterKey: "m", ThumbKey: "t", Renditions: rs, PlaylistKeys: make([]string, len(rs))}
	if ok, err := st.Complete(ctx, res); err != nil || ok {
		t.Fatalf("complete of a deleted video: %v %v", ok, err)
	}
	var n int
	_ = pg.Pool.QueryRow(ctx, `SELECT count(*) FROM media.outbox WHERE subject='video.ready' AND payload->'data'->>'video_id' = $1`, vid.String()).Scan(&n)
	if n != 0 {
		t.Fatalf("%d video.ready rows", n)
	}
}
