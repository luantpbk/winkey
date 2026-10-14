package integration

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/nats-io/nats.go/jetstream"

	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/libs/go/outbox"
	"github.com/luantpbk/winkey/services/upload/internal/contract"
	"github.com/luantpbk/winkey/services/upload/internal/domain"
	"github.com/luantpbk/winkey/services/upload/internal/janitor"
	"github.com/luantpbk/winkey/services/upload/internal/quota"
)

const (
	tmplTracks   = "/v1/uploads/{video_id}/audio-tracks"
	tmplTrack    = "/v1/uploads/{video_id}/audio-tracks/{track_id}"
	tmplParts    = "/v1/uploads/{video_id}/audio-tracks/{track_id}/parts"
	tmplComplete = "/v1/uploads/{video_id}/audio-tracks/{track_id}/complete"
)

type audioCreated struct {
	TrackID   string `json:"track_id"`
	PartSize  int64  `json:"part_size"`
	PartCount int    `json:"part_count"`
}

func (q *quotaStack) createAudio(t *testing.T, owner, videoID, lang, kind string, isDefault bool, size int64) (int, audioCreated, []byte) {
	t.Helper()
	code, _, raw := q.api(t, owner, "creator", "POST", tmplTracks, "/v1/uploads/"+videoID+"/audio-tracks", map[string]any{
		"lang": lang, "label": "Thuyết minh", "kind": kind, "is_default": isDefault,
		"filename": "a.flac", "content_type": "audio/flac", "size_bytes": size,
	})
	var c audioCreated
	if code == 201 {
		if err := json.Unmarshal(raw, &c); err != nil {
			t.Fatal(err)
		}
	}
	return code, c, raw
}

func problemOf(t *testing.T, raw []byte) string {
	t.Helper()
	var p struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(raw, &p)
	return p.Code
}

// TestAudioTrackUpload runs MUX1's audio upload against real PostgreSQL (migration 000023), Garage
// and NATS: the row, the ledger row, video.audio_uploaded delivered on the VIDEO stream, the
// (lang, kind) and default rules, the quota and the janitor.
func TestAudioTrackUpload(t *testing.T) {
	q := &quotaStack{
		stack: startQuota(t, quota.Limits{MaxConcurrent: 3, DailyCount: 20, DailyBytes: maxBytes}),
		spec:  contract.Load(t),
	}
	ctx := context.Background()
	owner := ids.NewString()
	v := q.create(t, owner, "creator", mib)
	if v.code != 201 {
		t.Fatalf("create video: %d", v.code)
	}
	base := "/v1/uploads/" + v.videoID + "/audio-tracks/"

	t.Run("upload, complete, event", func(t *testing.T) {
		size := int64(20<<20) + 7 // 2 parts
		code, c, raw := q.createAudio(t, owner, v.videoID, "vi", "voiceover", true, size)
		if code != 201 || c.PartCount != 2 {
			t.Fatalf("create: %d %s", code, raw)
		}
		code, _, raw = q.api(t, owner, "creator", "POST", tmplParts, base+c.TrackID+"/parts", map[string]any{"part_numbers": []int{1, 2}})
		if code != 200 {
			t.Fatalf("presign: %d %s", code, raw)
		}
		var pre struct {
			URLs []struct {
				PartNumber int    `json:"part_number"`
				URL        string `json:"url"`
			} `json:"urls"`
		}
		_ = json.Unmarshal(raw, &pre)
		var parts []map[string]any
		remaining := size
		for _, u := range pre.URLs {
			n := min(c.PartSize, remaining)
			remaining -= n
			buf := make([]byte, n)
			_, _ = rand.Read(buf)
			parts = append(parts, map[string]any{"part_number": u.PartNumber, "etag": putPart(t, u.URL, buf)})
		}
		code, _, raw = q.api(t, owner, "creator", "POST", tmplComplete, base+c.TrackID+"/complete", map[string]any{"parts": parts})
		if code != 202 {
			t.Fatalf("complete: %d %s", code, raw)
		}
		var tr struct {
			Status    string `json:"status"`
			IsDefault bool   `json:"is_default"`
		}
		_ = json.Unmarshal(raw, &tr)
		if tr.Status != "UPLOADED" || !tr.IsDefault {
			t.Fatalf("complete = %s", raw)
		}
		if code, _, _ := q.api(t, owner, "creator", "POST", tmplComplete, base+c.TrackID+"/complete", map[string]any{"parts": parts}); code != 202 {
			t.Fatalf("repeat complete: %d", code)
		}

		var status string
		var uploadID *string
		if err := q.pg.Pool.QueryRow(ctx, `SELECT status, s3_upload_id FROM media.video_audio_tracks WHERE id = $1`, c.TrackID).Scan(&status, &uploadID); err != nil {
			t.Fatal(err)
		}
		if status != "UPLOADED" || uploadID != nil {
			t.Fatalf("row: %s %v", status, uploadID)
		}
		var ledger int
		_ = q.pg.Pool.QueryRow(ctx, `SELECT count(*) FROM media.upload_ledger WHERE video_id = $1 AND owner_id = $2`, c.TrackID, owner).Scan(&ledger)
		if ledger != 1 {
			t.Fatalf("ledger rows for the track = %d", ledger)
		}

		cons, err := q.nats.JS.CreateOrUpdateConsumer(ctx, "VIDEO", jetstream.ConsumerConfig{FilterSubject: "video.audio_uploaded", AckPolicy: jetstream.AckExplicitPolicy})
		if err != nil {
			t.Fatal(err)
		}
		batch, err := cons.Fetch(2, jetstream.FetchMaxWait(5*time.Second))
		if err != nil {
			t.Fatal(err)
		}
		n := 0
		for m := range batch.Messages() {
			n++
			var env outbox.Envelope
			_ = json.Unmarshal(m.Data(), &env)
			var data domain.AudioUploadedEvent
			_ = json.Unmarshal(env.Data, &data)
			wantKey := owner + "/" + v.videoID + "/audio/" + c.TrackID + "/source"
			if env.Type != "video.audio_uploaded" || data.TrackID != c.TrackID || data.VideoID != v.videoID || data.OwnerID != owner ||
				data.Lang != "vi" || data.Kind != "voiceover" || data.RawKey != wantKey || data.SizeBytes != size {
				t.Fatalf("event: %+v %+v", env, data)
			}
			_ = m.Ack()
		}
		if n != 1 {
			t.Fatalf("video.audio_uploaded delivered %d times, want 1", n)
		}
	})

	t.Run("one per (lang, kind); a new default clears the old one", func(t *testing.T) {
		if code, _, raw := q.createAudio(t, owner, v.videoID, "vi", "voiceover", false, mib); code != 409 || problemOf(t, raw) != "AUDIO_TRACK_EXISTS" {
			t.Fatalf("duplicate: %d %s", code, raw)
		}
		code, c, raw := q.createAudio(t, owner, v.videoID, "en", "dub", true, mib)
		if code != 201 {
			t.Fatalf("en dub: %d %s", code, raw)
		}
		var def string
		if err := q.pg.Pool.QueryRow(ctx, `SELECT id::text FROM media.video_audio_tracks WHERE video_id = $1 AND is_default`, v.videoID).Scan(&def); err != nil || def != c.TrackID {
			t.Fatalf("default = %s, want %s (%v)", def, c.TrackID, err)
		}
	})

	t.Run("an open audio upload takes a concurrent slot", func(t *testing.T) {
		// Open now: the video (1) and the en dub (1). One more audio upload fills the 3 slots.
		if code, _, raw := q.createAudio(t, owner, v.videoID, "fr", "dub", false, mib); code != 201 {
			t.Fatalf("fr: %d %s", code, raw)
		}
		code, _, raw := q.createAudio(t, owner, v.videoID, "de", "dub", false, mib)
		if code != 429 || problemOf(t, raw) != "UPLOAD_QUOTA_EXCEEDED" {
			t.Fatalf("4th open upload: %d %s", code, raw)
		}
		wantQuota429(t, q.create(t, owner, "creator", mib), "concurrent")
	})

	t.Run("abort, janitor", func(t *testing.T) {
		var fr string
		if err := q.pg.Pool.QueryRow(ctx, `SELECT id::text FROM media.video_audio_tracks WHERE video_id = $1 AND lang = 'fr'`, v.videoID).Scan(&fr); err != nil {
			t.Fatal(err)
		}
		if code, _, raw := q.api(t, owner, "creator", "DELETE", tmplTrack, base+fr, nil); code != 204 {
			t.Fatalf("abort: %d %s", code, raw)
		}
		if _, err := q.pg.Pool.Exec(ctx, `
			UPDATE media.video_audio_tracks SET created_at = now() - interval '25 hours'
			WHERE video_id = $1 AND lang = 'en'`, v.videoID); err != nil {
			t.Fatal(err)
		}
		j := &janitor.Janitor{Store: q.store, Audio: q.store, Storage: q.stor, Log: slog.New(slog.NewJSONHandler(io.Discard, nil))}
		deleted, err := j.Sweep(ctx)
		if err != nil || deleted != 1 {
			t.Fatalf("sweep: %d %v", deleted, err)
		}
		var left []string
		rows, _ := q.pg.Pool.Query(ctx, `SELECT lang FROM media.video_audio_tracks WHERE video_id = $1 ORDER BY lang`, v.videoID)
		for rows.Next() {
			var l string
			_ = rows.Scan(&l)
			left = append(left, l)
		}
		if len(left) != 1 || left[0] != "vi" {
			t.Fatalf("tracks left = %v, want [vi]", left)
		}
	})

	t.Run("deleting the video deletes its tracks", func(t *testing.T) {
		q.deleteVideos(t, owner)
		var n int
		_ = q.pg.Pool.QueryRow(ctx, `SELECT count(*) FROM media.video_audio_tracks WHERE video_id = $1`, v.videoID).Scan(&n)
		if n != 0 {
			t.Fatalf("%d tracks survived the video", n)
		}
		if code, _, _ := q.createAudio(t, owner, v.videoID, "ja", "dub", false, mib); code != 404 {
			t.Fatalf("audio for a deleted video: %d", code)
		}
	})
}
