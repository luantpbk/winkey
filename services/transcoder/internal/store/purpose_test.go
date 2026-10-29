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

// SOC-2b (ADR-049): BeginJob hands the pipeline the video's purpose, video.ready carries it, and social videos
// are never AV1, re-encode or storyboard-backfill candidates (their raw is gone and they keep the social ladder).
// Real PostgreSQL.
func TestSocialPurposeThroughTheStore(t *testing.T) {
	pg := testkit.StartPostgres(t)
	ctx := context.Background()
	st := &store.Postgres{Pool: pg.Pool}
	schema := readySchema(t)

	social, owner := seed(t, pg, "UPLOADED")
	if _, err := pg.Pool.Exec(ctx, `UPDATE media.videos SET purpose = 'SOCIAL', visibility = 'UNLISTED' WHERE id = $1`, social); err != nil {
		t.Fatal(err)
	}
	film, _ := seed(t, pg, "UPLOADED")

	for _, c := range []struct {
		name, purpose string
	}{{social.String(), "SOCIAL"}, {film.String(), "FILM"}} {
		vid := social
		if c.purpose == "FILM" {
			vid = film
		}
		b, err := st.BeginJob(ctx, vid, "x264", "w")
		if err != nil || b.Video.Purpose != c.purpose {
			t.Fatalf("BeginJob purpose = %q (err %v), want %s", b.Video.Purpose, err, c.purpose)
		}
		rs := media.SelectSocial(720, 1280)
		prefix := "v/" + vid.String() + "/a1/"
		res := job.ReadyResult{VideoID: vid, OwnerID: owner, JobID: b.JobID, Attempt: 1, Encoder: "x264", DurationMs: 9000,
			Width: rs[0].Width, Height: rs[0].Height, MasterKey: prefix + "hls/master.m3u8", ThumbKey: prefix + "thumb/poster.jpg", Renditions: rs}
		for _, r := range rs {
			res.PlaylistKeys = append(res.PlaylistKeys, prefix+"hls/"+r.Name+"/index.m3u8")
		}
		if ok, err := st.Complete(ctx, res); err != nil || !ok {
			t.Fatalf("complete %s: %v %v", c.purpose, ok, err)
		}
		var payload []byte
		if err := pg.Pool.QueryRow(ctx, `SELECT payload FROM media.outbox WHERE subject = 'video.ready' AND payload->'data'->>'video_id' = $1`, vid.String()).Scan(&payload); err != nil {
			t.Fatal(err)
		}
		inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(payload))
		if err != nil {
			t.Fatal(err)
		}
		if err := schema.Validate(inst); err != nil {
			t.Fatalf("video.ready does not match its schema: %v\n%s", err, payload)
		}
		var env struct {
			Data struct {
				Purpose string `json:"purpose"`
			} `json:"data"`
		}
		if err := json.Unmarshal(payload, &env); err != nil || env.Data.Purpose != c.purpose {
			t.Fatalf("video.ready.purpose = %q (err %v), want %s", env.Data.Purpose, err, c.purpose)
		}
	}

	if cands, err := st.SelectAV1(ctx, 0, 100); err != nil || len(cands) != 1 || cands[0].ID != film {
		t.Fatalf("AV1 candidates %+v (err %v), want only the film", cands, err)
	}
	if cands, err := st.SelectReencode(ctx, nil); err != nil || len(cands) != 1 || cands[0].ID != film {
		t.Fatalf("re-encode candidates %+v (err %v), want only the film", cands, err)
	}
}
