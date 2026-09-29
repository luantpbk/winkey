// Package integration runs the transcoder against real PostgreSQL 17, NATS
// JetStream and Garage (testkit) with real ffmpeg (ENCODER=x264). The tests
// skip when Docker or ffmpeg is unavailable.
package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/google/uuid"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/libs/go/outbox"
	"github.com/luantpbk/winkey/libs/go/testkit"
	"github.com/luantpbk/winkey/services/transcoder/internal/job"
	"github.com/luantpbk/winkey/services/transcoder/internal/media"
	"github.com/luantpbk/winkey/services/transcoder/internal/objects"
	"github.com/luantpbk/winkey/services/transcoder/internal/store"
	"github.com/luantpbk/winkey/services/transcoder/internal/testutil"
	"github.com/luantpbk/winkey/services/transcoder/internal/worker"
)

type stack struct {
	pg    *testkit.Postgres
	nats  *testkit.NATS
	g     *testkit.Garage
	tools job.Tools
	log   *slog.Logger
	cons  *worker.Consumer
	obj   *objects.S3
}

func start(t *testing.T, encoder string) *stack {
	t.Helper()
	tools := testutil.ToolsFromEnv(t)
	s := &stack{
		pg: testkit.StartPostgres(t), nats: testkit.StartNATS(t), g: testkit.StartGarage(t), tools: tools,
		log: slog.New(slog.NewJSONHandler(io.Discard, nil)),
	}
	s.obj = objects.New(objects.Config{Endpoint: s.g.Endpoint, Region: s.g.Region, AccessKeyID: s.g.AccessKey, SecretKey: s.g.SecretKey})
	pipeline := &job.Pipeline{
		Store: &store.Postgres{Pool: s.pg.Pool}, Objects: s.obj, Events: natsPub{s.nats}, Tools: tools, Log: s.log,
		Cfg: job.Config{
			ScratchDir: t.TempDir(), ArchiveDir: t.TempDir(), MediaBucket: testkit.MediaBucket,
			Encoder: encoder, X264Preset: "veryfast", UploadParallelism: 8, WorkerID: "it",
		},
	}
	s.cons = &worker.Consumer{JS: s.nats.JS, Pipeline: pipeline, Concurrency: 2, Grace: 5 * time.Second, Log: s.log}

	outbox.SetProducer("transcoder")
	relay := &outbox.Relay{Pool: s.pg.Pool, Publisher: outbox.JetStreamPublisher{JS: s.nats.JS}, Schema: "media",
		Log: s.log, Listen: true, PollInterval: 200 * time.Millisecond}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() { _ = relay.Run(ctx) }()
	go func() { _ = s.cons.Run(ctx) }()
	return s
}

type natsPub struct{ n *testkit.NATS }

func (p natsPub) Publish(subject string, data []byte) error { return p.n.NC.Publish(subject, data) }

// seed creates an UPLOADED video whose raw object is the file at path, and
// returns the id, exactly as upload-svc would leave it (row + video.uploaded).
func (s *stack) seed(t *testing.T, path string) (videoID, ownerID uuid.UUID) {
	t.Helper()
	ctx := context.Background()
	videoID, ownerID = ids.New(), ids.New()
	rawKey := ownerID.String() + "/" + videoID.String() + "/source"

	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	st, _ := f.Stat()
	if _, err := s.g.S3Client().PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(testkit.RawBucket), Key: &rawKey, Body: f, ContentLength: aws.Int64(st.Size()),
	}); err != nil {
		t.Fatal(err)
	}

	tx, err := s.pg.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO media.videos (id, owner_id, title, status, raw_bucket, raw_key, content_type, size_bytes)
		VALUES ($1, $2, 'clip', 'UPLOADING', $3, $4, 'video/mp4', $5)`,
		videoID, ownerID, testkit.RawBucket, rawKey, st.Size()); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE media.videos SET status='UPLOADED' WHERE id=$1`, videoID); err != nil {
		t.Fatal(err)
	}
	if err := outbox.Enqueue(ctx, tx, "media", "video.uploaded", job.UploadedEvent{
		VideoID: videoID.String(), OwnerID: ownerID.String(), RawBucket: testkit.RawBucket, RawKey: rawKey, SizeBytes: st.Size(), ContentType: "video/mp4",
	}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return videoID, ownerID
}

func (s *stack) waitStatus(t *testing.T, id uuid.UUID, want string, within time.Duration) {
	t.Helper()
	deadline := time.Now().Add(within)
	var status string
	for time.Now().Before(deadline) {
		_ = s.pg.Pool.QueryRow(context.Background(), `SELECT status::text FROM media.videos WHERE id=$1`, id).Scan(&status)
		if status == want {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("video %s: status %q after %v, want %s", id, status, within, want)
}

func (s *stack) events(t *testing.T, subject string, n int) []outbox.Envelope {
	t.Helper()
	ctx := context.Background()
	cons, err := s.nats.JS.CreateOrUpdateConsumer(ctx, "VIDEO", jetstream.ConsumerConfig{
		FilterSubject: subject, AckPolicy: jetstream.AckExplicitPolicy,
	})
	if err != nil {
		t.Fatal(err)
	}
	batch, err := cons.Fetch(n, jetstream.FetchMaxWait(10*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	var out []outbox.Envelope
	for m := range batch.Messages() {
		var e outbox.Envelope
		_ = json.Unmarshal(m.Data(), &e)
		out = append(out, e)
		_ = m.Ack()
	}
	return out
}

func TestEndToEndX264(t *testing.T) {
	s := start(t, media.EncoderX264)
	ctx := context.Background()
	clips := map[string]testutil.Clip{
		"landscape": testutil.ClipLandscape, "portrait": testutil.ClipPortrait, "silent": testutil.ClipSilent,
	}
	for name, c := range clips {
		c := c
		t.Run(name, func(t *testing.T) {
			path := testutil.MakeClip(t, s.tools, t.TempDir(), c)
			id, owner := s.seed(t, path)
			s.waitStatus(t, id, "READY", 3*time.Minute)

			var master, thumb string
			var durMs, w, h int
			var published *time.Time
			if err := s.pg.Pool.QueryRow(ctx, `SELECT hls_master_key, thumbnail_key, duration_ms, width, height, published_at
				FROM media.videos WHERE id=$1`, id).Scan(&master, &thumb, &durMs, &w, &h, &published); err != nil {
				t.Fatal(err)
			}
			prefix := "v/" + id.String() + "/a1/"
			if master != prefix+"hls/master.m3u8" || thumb != prefix+"thumb/poster.jpg" || published == nil ||
				w != c.W && w != c.H || durMs < (c.Seconds-1)*1000 {
				t.Fatalf("row: master=%s thumb=%s dur=%d %dx%d published=%v", master, thumb, durMs, w, h, published)
			}

			// master.m3u8 has three variants; every playlist is readable with ffprobe over HTTP from Garage.
			cl := s.g.S3Client()
			obj, err := cl.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(testkit.MediaBucket), Key: &master})
			if err != nil {
				t.Fatal(err)
			}
			if aws.ToString(obj.ContentType) != "application/vnd.apple.mpegurl" || aws.ToString(obj.CacheControl) != "public, max-age=31536000, immutable" {
				t.Errorf("master headers: %q %q", aws.ToString(obj.ContentType), aws.ToString(obj.CacheControl))
			}
			body, _ := io.ReadAll(obj.Body)
			vars := media.ParseMaster(string(body))
			if len(vars) != 3 {
				t.Fatalf("variants: %+v\n%s", vars, body)
			}
			for _, v := range vars {
				if v.Bandwidth == 0 || v.Codecs == "" || v.Resolution == "" {
					t.Errorf("incomplete variant %+v", v)
				}
			}
			s.probeFromStorage(t, prefix, vars)

			var nRend int
			_ = s.pg.Pool.QueryRow(ctx, `SELECT count(*) FROM media.video_renditions WHERE video_id=$1`, id).Scan(&nRend)
			var jobStatus, encoder string
			var progress float32
			_ = s.pg.Pool.QueryRow(ctx, `SELECT status::text, encoder, progress FROM media.transcode_jobs WHERE video_id=$1`, id).Scan(&jobStatus, &encoder, &progress)
			if nRend != 3 || jobStatus != "SUCCEEDED" || encoder != "x264" || progress != 100 {
				t.Errorf("renditions=%d job=%s encoder=%s progress=%v", nRend, jobStatus, encoder, progress)
			}

			ready := s.events(t, "video.ready", 1)
			if len(ready) != 1 || ready[0].Producer != "transcoder" {
				t.Fatalf("video.ready: %+v", ready)
			}
			var data struct {
				VideoID string `json:"video_id"`
				OwnerID string `json:"owner_id"`
				Encoder string `json:"encoder"`
			}
			_ = json.Unmarshal(ready[0].Data, &data)
			if data.VideoID != id.String() || data.OwnerID != owner.String() || data.Encoder != "x264" {
				t.Fatalf("video.ready data: %+v", data)
			}

			// The raw archive copy exists.
			if _, err := os.Stat(filepath.Join(s.cons.Pipeline.Cfg.ArchiveDir, owner.String(), id.String(), "source")); err != nil {
				t.Errorf("archive: %v", err)
			}
		})
	}
}

// probeFromStorage downloads each variant playlist and its segments from Garage
// into a temp dir, keeping the layout, and lets ffprobe read them.
func (s *stack) probeFromStorage(t *testing.T, prefix string, vars []media.Variant) {
	t.Helper()
	ctx := context.Background()
	dir := t.TempDir()
	cl := s.g.S3Client()
	pg := s3.NewListObjectsV2Paginator(cl, &s3.ListObjectsV2Input{Bucket: aws.String(testkit.MediaBucket), Prefix: aws.String(prefix + "hls/")})
	for pg.HasMorePages() {
		page, err := pg.NextPage(ctx)
		if err != nil {
			t.Fatal(err)
		}
		for _, o := range page.Contents {
			rel := (*o.Key)[len(prefix+"hls/"):]
			dst := filepath.Join(dir, filepath.FromSlash(rel))
			_ = os.MkdirAll(filepath.Dir(dst), 0o755)
			if err := s.obj.Download(ctx, testkit.MediaBucket, *o.Key, dst); err != nil {
				t.Fatal(err)
			}
		}
	}
	for _, v := range vars {
		info, err := s.tools.Probe(ctx, filepath.Join(dir, filepath.FromSlash(v.URI)))
		if err != nil {
			t.Fatalf("ffprobe %s: %v", v.URI, err)
		}
		if !info.HasAudio || info.DurationSec <= 0 {
			t.Errorf("%s: %+v", v.URI, info)
		}
	}
}

func TestInvalidInputFailsVideoAndEmitsEvent(t *testing.T) {
	s := start(t, media.EncoderX264)
	junk := filepath.Join(t.TempDir(), "junk.mp4")
	_ = os.WriteFile(junk, bytes.Repeat([]byte("not a video "), 1000), 0o644)
	id, owner := s.seed(t, junk)

	s.waitStatus(t, id, "FAILED", time.Minute)
	var errMsg string
	_ = s.pg.Pool.QueryRow(context.Background(), `SELECT error FROM media.videos WHERE id=$1`, id).Scan(&errMsg)
	if errMsg == "" {
		t.Error("owner-safe error message missing")
	}
	failed := s.events(t, "video.failed", 1)
	if len(failed) != 1 {
		t.Fatal("video.failed not published")
	}
	var d struct {
		VideoID   string `json:"video_id"`
		OwnerID   string `json:"owner_id"`
		Reason    string `json:"reason"`
		Retryable bool   `json:"retryable"`
		Attempt   int    `json:"attempt"`
	}
	_ = json.Unmarshal(failed[0].Data, &d)
	if d.VideoID != id.String() || d.OwnerID != owner.String() || d.Reason != "INVALID_INPUT" || d.Retryable || d.Attempt != 1 {
		t.Fatalf("video.failed data: %+v", d)
	}
	// Non-retryable: Term without a DLQ copy.
	time.Sleep(time.Second)
	if info, err := s.nats.JS.Stream(context.Background(), "DLQ"); err == nil {
		si, _ := info.Info(context.Background())
		if si.State.Msgs != 0 {
			t.Errorf("DLQ has %d messages for a non-retryable failure", si.State.Msgs)
		}
	}
}

func TestDeletedVideoIsPurged(t *testing.T) {
	s := start(t, media.EncoderX264)
	ctx := context.Background()
	id := ids.New()
	owner := ids.New()
	cl := s.g.S3Client()
	put := func(bucket, key string) {
		if _, err := cl.PutObject(ctx, &s3.PutObjectInput{Bucket: aws.String(bucket), Key: aws.String(key), Body: bytes.NewReader([]byte("x"))}); err != nil {
			t.Fatal(err)
		}
	}
	put(testkit.MediaBucket, "v/"+id.String()+"/a1/hls/master.m3u8")
	put(testkit.MediaBucket, "v/"+id.String()+"/a2/thumb/poster.jpg")
	put(testkit.RawBucket, owner.String()+"/"+id.String()+"/source")

	j := &worker.Janitor{JS: s.nats.JS, Objects: s.obj, MediaBucket: testkit.MediaBucket, RawBucket: testkit.RawBucket, Log: s.log}
	jctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() { _ = j.Run(jctx) }()

	_, payload, _ := outbox.BuildEnvelope(ctx, "video.deleted", map[string]any{
		"video_id": id.String(), "owner_id": owner.String(),
		"raw_bucket": testkit.RawBucket, "raw_key": owner.String() + "/" + id.String() + "/source",
		"media_bucket": testkit.MediaBucket, "media_prefix": "v/" + id.String() + "/",
	})
	if _, err := s.nats.JS.Publish(ctx, "video.deleted", payload); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(30 * time.Second)
	for {
		out, _ := cl.ListObjectsV2(ctx, &s3.ListObjectsV2Input{Bucket: aws.String(testkit.MediaBucket), Prefix: aws.String("v/" + id.String() + "/")})
		raw, _ := cl.ListObjectsV2(ctx, &s3.ListObjectsV2Input{Bucket: aws.String(testkit.RawBucket), Prefix: aws.String(owner.String() + "/")})
		if len(out.Contents) == 0 && len(raw.Contents) == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("objects remain: media=%d raw=%d", len(out.Contents), len(raw.Contents))
		}
		time.Sleep(300 * time.Millisecond)
	}
}

func TestReplayDLQ(t *testing.T) {
	s := start(t, media.EncoderX264)
	ctx := context.Background()
	id := ids.New()
	_, payload, _ := outbox.BuildEnvelope(ctx, "video.uploaded", job.UploadedEvent{
		VideoID: id.String(), OwnerID: ids.NewString(), RawBucket: "b", RawKey: "k", SizeBytes: 1, ContentType: "video/mp4",
	})
	if _, err := s.nats.JS.Publish(ctx, "dlq.video.uploaded", payload); err != nil {
		t.Fatal(err)
	}

	rep, err := worker.ReplayDLQ(ctx, s.nats.JS, worker.ReplayOptions{DryRun: true})
	if err != nil || rep.Matched != 1 || rep.Replayed != 0 {
		t.Fatalf("dry run: %+v %v", rep, err)
	}
	if rep, _ = worker.ReplayDLQ(ctx, s.nats.JS, worker.ReplayOptions{VideoID: "someone-else"}); rep.Matched != 0 {
		t.Fatalf("filter ignored: %+v", rep)
	}
	rep, err = worker.ReplayDLQ(ctx, s.nats.JS, worker.ReplayOptions{VideoID: id.String()})
	if err != nil || rep.Replayed != 1 {
		t.Fatalf("replay: %+v %v", rep, err)
	}
	// Replayed messages are not offered again.
	if rep, _ = worker.ReplayDLQ(ctx, s.nats.JS, worker.ReplayOptions{}); rep.Matched != 0 {
		t.Fatalf("message replayed twice: %+v", rep)
	}
}
