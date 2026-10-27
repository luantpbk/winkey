package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"testing"
	"time"

	"github.com/nats-io/nats.go/jetstream"

	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/services/upload/internal/api"
	"github.com/luantpbk/winkey/services/upload/internal/contract"
	"github.com/luantpbk/winkey/services/upload/internal/janitor"
	"github.com/luantpbk/winkey/services/upload/internal/quota"
)

// Task SOC-1b on real PostgreSQL, NATS and Garage: createImageUpload → PUT through the presigned URL →
// completeImageUpload → media.image_uploaded on JetStream; quotas; the janitor; every response contract-checked.

type imageCreated struct {
	ImageID       string            `json:"image_id"`
	UploadURL     string            `json:"upload_url"`
	UploadHeaders map[string]string `json:"upload_headers"`
}

type imageView struct {
	ID     string  `json:"id"`
	Status string  `json:"status"`
	URL    *string `json:"url"`
}

func putImage(t *testing.T, c imageCreated, data []byte) int {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPut, c.UploadURL, bytes.NewReader(data))
	for k, v := range c.UploadHeaders {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	return resp.StatusCode
}

func TestImageUpload(t *testing.T) {
	q := &quotaStack{stack: startWith(t, quota.Limits{}, &api.ImageLimits{MaxPending: 2, DailyCount: 4}), spec: contract.Load(t)}
	owner := ids.NewString()
	data := bytes.Repeat([]byte{0xff, 0xd8, 0xff}, 1000) // the transcoder validates content; upload-svc does not

	create := func(owner string, size int) (int, imageCreated, []byte) {
		t.Helper()
		code, _, raw := q.api(t, owner, "viewer", "POST", "/v1/images", "/v1/images",
			map[string]any{"purpose": "AVATAR", "content_type": "image/jpeg", "size_bytes": size})
		var c imageCreated
		_ = json.Unmarshal(raw, &c)
		return code, c, raw
	}

	t.Run("viewer uploads, completes, event published", func(t *testing.T) {
		code, c, raw := create(owner, len(data))
		if code != 201 || c.UploadHeaders["Content-Type"] != "image/jpeg" {
			t.Fatalf("%d %s", code, raw)
		}
		// A different size than declared is refused by the storage (Content-Length is signed).
		if got := putImage(t, c, append(append([]byte{}, data...), 0)); got == 200 {
			t.Fatal("a larger body than size_bytes was accepted")
		}
		// Completing before the upload → 409 UPLOAD_INCOMPLETE.
		code, _, raw = q.api(t, owner, "viewer", "POST", "/v1/images/{image_id}/complete", "/v1/images/"+c.ImageID+"/complete", nil)
		if code != 409 || problemOf(t, raw) != "UPLOAD_INCOMPLETE" {
			t.Fatalf("complete before upload: %d %s", code, raw)
		}
		if got := putImage(t, c, data); got != 200 {
			t.Fatalf("put %d", got)
		}
		code, _, raw = q.api(t, owner, "viewer", "POST", "/v1/images/{image_id}/complete", "/v1/images/"+c.ImageID+"/complete", nil)
		var v imageView
		_ = json.Unmarshal(raw, &v)
		if code != 202 || v.Status != "PROCESSING" || v.URL != nil {
			t.Fatalf("complete: %d %s", code, raw)
		}
		// Idempotent.
		code, _, _ = q.api(t, owner, "viewer", "POST", "/v1/images/{image_id}/complete", "/v1/images/"+c.ImageID+"/complete", nil)
		if code != 202 {
			t.Fatalf("second complete: %d", code)
		}

		cons, err := q.nats.JS.CreateOrUpdateConsumer(context.Background(), "VIDEO", jetstream.ConsumerConfig{
			FilterSubject: "media.image_uploaded", AckPolicy: jetstream.AckExplicitPolicy, DeliverPolicy: jetstream.DeliverAllPolicy,
		})
		if err != nil {
			t.Fatal(err)
		}
		batch, err := cons.Fetch(5, jetstream.FetchMaxWait(5*time.Second))
		if err != nil {
			t.Fatal(err)
		}
		var events []map[string]any
		for m := range batch.Messages() {
			var env struct {
				Type string         `json:"type"`
				Data map[string]any `json:"data"`
			}
			_ = json.Unmarshal(m.Data(), &env)
			if env.Type == "media.image_uploaded" && env.Data["image_id"] == c.ImageID {
				events = append(events, env.Data)
			}
			_ = m.Ack()
		}
		if len(events) != 1 || events[0]["owner_id"] != owner || events[0]["purpose"] != "AVATAR" ||
			events[0]["raw_key"] != owner+"/images/"+c.ImageID {
			t.Fatalf("events %v", events)
		}

		// READY (as the transcoder would set it) → public URLs.
		if _, err := q.pg.Pool.Exec(context.Background(), `UPDATE media.images SET status = 'READY',
			image_key = 'i/'||owner_id||'/'||id||'/image.webp', thumb_key = 'i/'||owner_id||'/'||id||'/thumb.webp',
			width = 400, height = 400, output_bytes = 1000 WHERE id = $1`, c.ImageID); err != nil {
			t.Fatal(err)
		}
		code, _, raw = q.api(t, owner, "viewer", "GET", "/v1/images/{image_id}", "/v1/images/"+c.ImageID, nil)
		_ = json.Unmarshal(raw, &v)
		if code != 200 || v.URL == nil || *v.URL != testMediaBase+"/i/"+owner+"/"+c.ImageID+"/image.webp" {
			t.Fatalf("get: %d %s", code, raw)
		}
		// Another user's image is 404.
		code, _, _ = q.api(t, ids.NewString(), "viewer", "GET", "/v1/images/{image_id}", "/v1/images/"+c.ImageID, nil)
		if code != 404 {
			t.Fatalf("other user's image: %d", code)
		}
	})

	t.Run("validation", func(t *testing.T) {
		for name, body := range map[string]map[string]any{
			"gif":     {"purpose": "POST", "content_type": "image/gif", "size_bytes": 10},
			"purpose": {"purpose": "STORY", "content_type": "image/png", "size_bytes": 10},
			"zero":    {"purpose": "POST", "content_type": "image/png", "size_bytes": 0},
		} {
			code, _, raw := q.api(t, owner, "viewer", "POST", "/v1/images", "/v1/images", body)
			if code != 400 {
				t.Errorf("%s: %d %s", name, code, raw)
			}
		}
		code, _, raw := q.api(t, owner, "viewer", "POST", "/v1/images", "/v1/images",
			map[string]any{"purpose": "POST", "content_type": "image/png", "size_bytes": 21 << 20})
		if code != 400 || problemOf(t, raw) != "UPLOAD_TOO_LARGE" {
			t.Fatalf("too large: %d %s", code, raw)
		}
	})

	t.Run("quotas", func(t *testing.T) {
		u := ids.NewString()
		for i := 0; i < 2; i++ {
			if code, _, raw := create(u, 10); code != 201 {
				t.Fatalf("image %d: %d %s", i, code, raw)
			}
		}
		code, _, raw := create(u, 10) // third pending
		if code != 429 || problemOf(t, raw) != "UPLOAD_QUOTA_EXCEEDED" {
			t.Fatalf("pending limit: %d %s", code, raw)
		}
		// Admins are exempt.
		if code, _, _ := q.api(t, u, "viewer,admin", "POST", "/v1/images", "/v1/images",
			map[string]any{"purpose": "POST", "content_type": "image/png", "size_bytes": 10}); code != 201 {
			t.Fatalf("admin: %d", code)
		}
		// Finish the pending ones; the daily count (4, admin's included) then refuses the next.
		if _, err := q.pg.Pool.Exec(context.Background(), `UPDATE media.images SET status = 'FAILED', error = 'INVALID_INPUT'
			WHERE owner_id = $1`, u); err != nil {
			t.Fatal(err)
		}
		if code, _, raw := create(u, 10); code != 201 {
			t.Fatalf("4th: %d %s", code, raw)
		}
		code, _, raw = create(u, 10)
		if code != 429 || problemOf(t, raw) != "UPLOAD_QUOTA_EXCEEDED" {
			t.Fatalf("daily limit: %d %s", code, raw)
		}
	})

	t.Run("janitor deletes stale uploads", func(t *testing.T) {
		u := ids.NewString()
		_, c, _ := create(u, len(data))
		if got := putImage(t, c, data); got != 200 {
			t.Fatalf("put %d", got)
		}
		if _, err := q.pg.Pool.Exec(context.Background(), `UPDATE media.images SET created_at = now() - interval '2 hours' WHERE id = $1`, c.ImageID); err != nil {
			t.Fatal(err)
		}
		j := &janitor.Janitor{Store: q.store, Storage: q.stor, Log: slog.New(slog.NewJSONHandler(io.Discard, nil)), Images: q.store, ImageStorage: q.stor}
		if _, err := j.Sweep(context.Background()); err != nil {
			t.Fatal(err)
		}
		var n int
		_ = q.pg.Pool.QueryRow(context.Background(), `SELECT count(*) FROM media.images WHERE id = $1`, c.ImageID).Scan(&n)
		if n != 0 {
			t.Fatal("stale image row kept")
		}
		if _, err := q.stor.HeadSize(context.Background(), "winkey-raw", u+"/images/"+c.ImageID); err == nil {
			t.Fatal("stale image object kept")
		}
	})
}
