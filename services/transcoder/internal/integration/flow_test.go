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
	"github.com/luantpbk/winkey/libs/go/s3x"
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

func start(t *testing.T, encoder string) *stack { return startStack(t, encoder, true) }

// startStack boots PostgreSQL, NATS and the outbox relay. With full=true it
// also starts Garage and the transcoder consumer.
func startStack(t *testing.T, encoder string, full bool) *stack {
	t.Helper()
	var tools job.Tools // ffmpeg is only needed when the transcoder consumer runs
	if full {
		tools = testutil.ToolsFromEnv(t)
	}
	s := &stack{
		pg: testkit.StartPostgres(t), nats: testkit.StartNATS(t), tools: tools,
		log: testLogger(),
	}
	if full {
		s.g = testkit.StartGarage(t)
		s3c, err := s3x.New(s3x.Config{Endpoint: s.g.Endpoint, Region: s.g.Region, AccessKeyID: s.g.AccessKey, SecretAccessKey: s.g.SecretKey})
		if err != nil {
			t.Fatal(err)
		}
		s.obj = objects.New(s3c)
	}
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
	if full {
		go func() { _ = s.cons.Run(ctx) }()
	}
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
	defer func() { _ = f.Close() }()
	st, _ := f.Stat()
	if s.g != nil { // without Garage the row and event are enough
		if _, err := s.g.S3Client().PutObject(ctx, &s3.PutObjectInput{
			Bucket: aws.String(testkit.RawBucket), Key: &rawKey, Body: f, ContentLength: aws.Int64(st.Size()),
		}); err != nil {
			t.Fatal(err)
		}
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

// events returns the events on subject whose data.video_id equals videoID,
// waiting up to 10 s for at least one. Filtering by video matters: the stream
// keeps every video's events, and subtests share one stack.
func (s *stack) events(t *testing.T, subject, videoID string) []outbox.Envelope {
	t.Helper()
	ctx := context.Background()
	cons, err := s.nats.JS.CreateOrUpdateConsumer(ctx, "VIDEO", jetstream.ConsumerConfig{
		FilterSubject: subject, AckPolicy: jetstream.AckNonePolicy,
	})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		var out []outbox.Envelope
		batch, err := cons.Fetch(100, jetstream.FetchMaxWait(time.Second))
		if err != nil {
			t.Fatal(err)
		}
		for m := range batch.Messages() {
			var e outbox.Envelope
			var d struct {
				VideoID string `json:"video_id"`
			}
			if json.Unmarshal(m.Data(), &e) == nil && json.Unmarshal(e.Data, &d) == nil && d.VideoID == videoID {
				out = append(out, e)
			}
		}
		if len(out) > 0 || time.Now().After(deadline) {
			return out
		}
	}
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
			var storyboard *string
			var durMs, w, h int
			var published *time.Time
			if err := s.pg.Pool.QueryRow(ctx, `SELECT hls_master_key, thumbnail_key, storyboard_key, duration_ms, width, height, published_at
				FROM media.videos WHERE id=$1`, id).Scan(&master, &thumb, &storyboard, &durMs, &w, &h, &published); err != nil {
				t.Fatal(err)
			}
			prefix := "v/" + id.String() + "/a1/"
			if master != prefix+"hls/master.m3u8" || thumb != prefix+"thumb/poster.jpg" || published == nil ||
				w != c.W && w != c.H || durMs < (c.Seconds-1)*1000 {
				t.Fatalf("row: master=%s thumb=%s dur=%d %dx%d published=%v", master, thumb, durMs, w, h, published)
			}

			// V5a: the storyboard key is in the row that became READY, and sheets + track are in Garage
			// with the right content types.
			if storyboard == nil || *storyboard != prefix+"storyboard/storyboard.vtt" {
				t.Fatalf("storyboard_key = %v", storyboard)
			}
			cl0 := s.g.S3Client()
			vtt, err := cl0.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(testkit.MediaBucket), Key: storyboard})
			if err != nil {
				t.Fatal(err)
			}
			vttBody, _ := io.ReadAll(vtt.Body)
			if aws.ToString(vtt.ContentType) != "text/vtt" || aws.ToString(vtt.CacheControl) != "public, max-age=31536000, immutable" ||
				!bytes.HasPrefix(vttBody, []byte("WEBVTT\n\n00:00:00.000 --> ")) {
				t.Errorf("vtt: %q %q %.60q", aws.ToString(vtt.ContentType), aws.ToString(vtt.CacheControl), vttBody)
			}
			sheetKey := prefix + "storyboard/sheet-001.jpg"
			sheet, err := cl0.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(testkit.MediaBucket), Key: &sheetKey})
			if err != nil {
				t.Fatal(err)
			}
			sheetBody, _ := io.ReadAll(sheet.Body)
			if aws.ToString(sheet.ContentType) != "image/jpeg" || len(sheetBody) < 1000 || sheetBody[0] != 0xFF || sheetBody[1] != 0xD8 {
				t.Errorf("sheet: %q, %d bytes", aws.ToString(sheet.ContentType), len(sheetBody))
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

			ready := s.events(t, "video.ready", id.String())
			if len(ready) != 1 || ready[0].Producer != "transcoder" {
				t.Fatalf("video.ready: %+v", ready)
			}
			var data struct {
				VideoID string `json:"video_id"`
				OwnerID string `json:"owner_id"`
				Encoder string `json:"encoder"`
				// C4-b: the visibility of the row when it became READY
				Visibility string `json:"visibility"`
				// V5a
				StoryboardKey *string `json:"storyboard_key"`
			}
			_ = json.Unmarshal(ready[0].Data, &data)
			if data.Visibility != "PUBLIC" { // seed() creates PUBLIC videos
				t.Errorf("video.ready visibility = %q, want PUBLIC", data.Visibility)
			}
			if data.StoryboardKey == nil || *data.StoryboardKey != *storyboard {
				t.Errorf("video.ready storyboard_key = %v, want %s", data.StoryboardKey, *storyboard)
			}
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
	failed := s.events(t, "video.failed", id.String())
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
	s := startStack(t, media.EncoderX264, false)
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

// A message whose deliveries all end without an ack (worker died repeatedly)
// makes JetStream publish a max-deliveries advisory; the watcher must fail the
// video, emit video.failed and copy the message to the DLQ.
func TestMaxDeliveriesAdvisoryFailsVideo(t *testing.T) {
	s := startStack(t, media.EncoderX264, false)
	ctx := context.Background()
	junk := filepath.Join(t.TempDir(), "raw.bin")
	_ = os.WriteFile(junk, []byte("x"), 0o644)

	// Stop the real consumer from competing: this test uses its own consumer,
	// with a short ack_wait and max_deliver 2, and a video the worker "crashed" on.
	id, owner := s.seedProcessing(t, junk)
	cons, err := s.nats.JS.CreateOrUpdateConsumer(ctx, "VIDEO", jetstream.ConsumerConfig{
		Durable: "advisory-test", FilterSubject: "video.uploaded", AckPolicy: jetstream.AckExplicitPolicy,
		AckWait: time.Second, MaxDeliver: 2, DeliverPolicy: jetstream.DeliverAllPolicy,
	})
	if err != nil {
		t.Fatal(err)
	}
	w := &worker.Watcher{NC: s.nats.NC, JS: s.nats.JS, Store: &store.Postgres{Pool: s.pg.Pool}, Consumer: "advisory-test", Log: s.log}
	wctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if err := w.Start(wctx); err != nil {
		t.Fatal(err)
	}
	go func() { _ = w.Run(wctx) }()

	// Receive the message max_deliver times and never ack it.
	for i := 0; i < 2; i++ {
		batch, err := cons.Fetch(1, jetstream.FetchMaxWait(10*time.Second))
		if err != nil {
			t.Fatal(err)
		}
		n := 0
		for range batch.Messages() {
			n++
		}
		if n != 1 {
			t.Fatalf("delivery %d: got %d messages", i+1, n)
		}
	}

	// JetStream announces the exhausted message when a puller asks for more
	// after the last ack_wait expired; a running worker always has a pull open.
	go func() {
		for wctx.Err() == nil {
			b, err := cons.Fetch(1, jetstream.FetchMaxWait(3*time.Second))
			if err == nil {
				for range b.Messages() {
				}
			}
		}
	}()
	s.waitStatus(t, id, "FAILED", 30*time.Second)
	failed := s.events(t, "video.failed", id.String())
	if len(failed) != 1 {
		t.Fatal("video.failed not published")
	}
	var d struct {
		VideoID   string `json:"video_id"`
		OwnerID   string `json:"owner_id"`
		Reason    string `json:"reason"`
		Retryable bool   `json:"retryable"`
	}
	_ = json.Unmarshal(failed[0].Data, &d)
	if d.VideoID != id.String() || d.OwnerID != owner.String() || d.Reason != "INTERNAL" || !d.Retryable {
		t.Fatalf("video.failed: %+v", d)
	}
	dlq, err := s.nats.JS.Stream(ctx, "DLQ")
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		si, _ := dlq.Info(ctx)
		if si != nil && si.State.Msgs == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("DLQ copy missing")
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// seedProcessing is seed plus a RUNNING job, as left by a worker that died.
func (s *stack) seedProcessing(t *testing.T, path string) (uuid.UUID, uuid.UUID) {
	t.Helper()
	id, owner := s.seed(t, path)
	if _, err := (&store.Postgres{Pool: s.pg.Pool}).BeginJob(context.Background(), id, "x264", "dead-worker"); err != nil {
		t.Fatal(err)
	}
	return id, owner
}

// testLogger discards logs unless WINKEY_TEST_LOG is set (debugging aid).
func testLogger() *slog.Logger {
	if os.Getenv("WINKEY_TEST_LOG") != "" {
		return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug}))
	}
	return slog.New(slog.NewJSONHandler(io.Discard, nil))
}
