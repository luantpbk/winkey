package integration

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/libs/go/outbox"
	"github.com/luantpbk/winkey/libs/go/testkit"
	"github.com/luantpbk/winkey/services/transcoder/internal/job"
	"github.com/luantpbk/winkey/services/transcoder/internal/media"
	"github.com/luantpbk/winkey/services/transcoder/internal/store"
	"github.com/luantpbk/winkey/services/transcoder/internal/testutil"
	"github.com/luantpbk/winkey/services/transcoder/internal/worker"
)

// SIGTERM handling (the systemd unit stops the service with SIGTERM and gives it
// TimeoutStopSec). main turns SIGTERM into the cancellation of the context passed
// to worker.Consumer.Run (signal.NotifyContext), so these tests cancel that
// context in the middle of a real job on real PostgreSQL, real NATS JetStream
// and real ffmpeg, and check what a stop leaves behind:
//
//   - a job that fits in SHUTDOWN_GRACE finishes and its message is acknowledged;
//   - a job that does not is cancelled and its message goes back to the queue:
//     the job row is closed (never left RUNNING), the video stays PROCESSING (it
//     is not blamed), nothing half-uploaded remains, and another worker completes
//     the video.
//
// A worker that dies without shutting down (SIGKILL, power loss) leaves a RUNNING
// job behind; that case belongs to the stuck-job reconciler (store tests).

type stopRig struct {
	t     *testing.T
	pg    *testkit.Postgres
	nats  *testkit.NATS
	tools job.Tools
	objs  *testutil.MemObjects
	log   *slog.Logger
	scr   string
}

func newStopRig(t *testing.T) *stopRig {
	t.Helper()
	tools := testutil.ToolsFromEnv(t)
	return &stopRig{
		t: t, pg: testkit.StartPostgres(t), nats: testkit.StartNATS(t), tools: tools,
		objs: testutil.NewMemObjects(), log: slog.New(slog.NewJSONHandler(io.Discard, nil)), scr: t.TempDir(),
	}
}

type natsEventsPub struct{ nc *nats.Conn }

func (p natsEventsPub) Publish(subject string, data []byte) error { return p.nc.Publish(subject, data) }

func (r *stopRig) consumer(preset string, grace time.Duration) *worker.Consumer {
	pipe := &job.Pipeline{
		Store: &store.Postgres{Pool: r.pg.Pool}, Objects: r.objs, Events: natsEventsPub{r.nats.NC}, Tools: r.tools, Log: r.log,
		Cfg: job.Config{
			ScratchDir: r.scr, MediaBucket: testutil.MediaBucket, Encoder: media.EncoderX264, X264Preset: preset,
			UploadParallelism: 4, WorkerID: "stop-test", ProgressInterval: 100 * time.Millisecond,
		},
	}
	return &worker.Consumer{JS: r.nats.JS, Pipeline: pipe, Concurrency: 1, Grace: grace, Log: r.log}
}

// submit stores the clip as the raw object, inserts an UPLOADED video and
// publishes video.uploaded, like upload-svc does.
func (r *stopRig) submit(clip string) uuid.UUID {
	r.t.Helper()
	data, err := os.ReadFile(clip)
	if err != nil {
		r.t.Fatal(err)
	}
	ctx := context.Background()
	vid, owner := ids.New(), ids.New()
	rawKey := owner.String() + "/" + vid.String() + "/source"
	r.objs.Put(testutil.RawBucket, rawKey, data)
	if _, err := r.pg.Pool.Exec(ctx, `
		INSERT INTO media.videos (id, owner_id, title, status, raw_bucket, raw_key, content_type, size_bytes)
		VALUES ($1, $2, 'stop test', 'UPLOADING', $3, $4, 'video/mp4', $5)`,
		vid, owner, testutil.RawBucket, rawKey, len(data)); err != nil {
		r.t.Fatal(err)
	}
	if _, err := r.pg.Pool.Exec(ctx, `UPDATE media.videos SET status='UPLOADED' WHERE id=$1`, vid); err != nil {
		r.t.Fatal(err)
	}
	outbox.SetProducer("upload-svc")
	_, payload, err := outbox.BuildEnvelope(ctx, "video.uploaded", job.UploadedEvent{
		VideoID: vid.String(), OwnerID: owner.String(), RawBucket: testutil.RawBucket, RawKey: rawKey,
		SizeBytes: int64(len(data)), ContentType: "video/mp4",
	})
	if err != nil {
		r.t.Fatal(err)
	}
	if _, err := r.nats.JS.Publish(ctx, "video.uploaded", payload); err != nil {
		r.t.Fatal(err)
	}
	return vid
}

// subscribeStages streams the stages the worker announces for the video on core NATS.
func (r *stopRig) subscribeStages(vid uuid.UUID) <-chan string {
	ch := make(chan string, 64)
	sub, err := r.nats.NC.Subscribe("rt.video."+vid.String()+".progress", func(m *nats.Msg) {
		var env struct {
			Data struct {
				Stage string `json:"stage"`
			} `json:"data"`
		}
		if json.Unmarshal(m.Data, &env) == nil {
			select {
			case ch <- env.Data.Stage:
			default:
			}
		}
	})
	if err != nil {
		r.t.Fatal(err)
	}
	r.t.Cleanup(func() { _ = sub.Unsubscribe() })
	_ = r.nats.NC.Flush()
	return ch
}

func waitStage(t *testing.T, ch <-chan string, stage string, d time.Duration) {
	t.Helper()
	deadline := time.After(d)
	for {
		select {
		case s := <-ch:
			if s == stage {
				return
			}
		case <-deadline:
			t.Fatalf("the worker never reached stage %s", stage)
		}
	}
}

func (r *stopRig) videoStatus(vid uuid.UUID) string {
	var s string
	_ = r.pg.Pool.QueryRow(context.Background(), `SELECT status::text FROM media.videos WHERE id=$1`, vid).Scan(&s)
	return s
}

func (r *stopRig) jobs(vid uuid.UUID) (statuses []string, errs []string) {
	rows, err := r.pg.Pool.Query(context.Background(),
		`SELECT status::text, coalesce(error, '') FROM media.transcode_jobs WHERE video_id=$1 ORDER BY attempt`, vid)
	if err != nil {
		r.t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var s, e string
		_ = rows.Scan(&s, &e)
		statuses, errs = append(statuses, s), append(errs, e)
	}
	return
}

func (r *stopRig) runningJobs() int {
	var n int
	_ = r.pg.Pool.QueryRow(context.Background(), `SELECT count(*) FROM media.transcode_jobs WHERE status='RUNNING'`).Scan(&n)
	return n
}

func (r *stopRig) queue(t *testing.T) *jetstream.ConsumerInfo {
	t.Helper()
	c, err := r.nats.JS.Consumer(context.Background(), worker.StreamVideo, worker.ConsumerName)
	if err != nil {
		t.Fatal(err)
	}
	info, err := c.Info(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return info
}

func (r *stopRig) waitVideo(vid uuid.UUID, want string, d time.Duration) {
	r.t.Helper()
	deadline := time.Now().Add(d)
	for r.videoStatus(vid) != want {
		if time.Now().After(deadline) {
			r.t.Fatalf("video %s is %s after %v, want %s", vid, r.videoStatus(vid), d, want)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// run starts the consumer; cancel stands for SIGTERM (main cancels this context via
// signal.NotifyContext) and done is closed when Run has returned.
func run(c *worker.Consumer) (cancel context.CancelFunc, done <-chan struct{}) {
	ctx, cancel := context.WithCancel(context.Background())
	ch := make(chan struct{})
	go func() {
		defer close(ch)
		_ = c.Run(ctx)
	}()
	return cancel, ch
}

// A job that fits in the grace period is finished, not abandoned.
func TestSIGTERMLetsAJobFinishWithinTheGracePeriod(t *testing.T) {
	r := newStopRig(t)
	clip := testutil.MakeClip(t, r.tools, t.TempDir(), testutil.ClipSilent) // 12 s, 3 renditions

	cons := r.consumer("veryfast", 3*time.Minute)
	cancel, done := run(cons)
	defer cancel()
	time.Sleep(500 * time.Millisecond) // the consumer is pulling

	vid := r.submit(clip)
	st := r.subscribeStages(vid)
	waitStage(t, st, "TRANSCODING", 60*time.Second)

	stopped := time.Now()
	cancel() // what SIGTERM does
	select {
	case <-done:
	case <-time.After(3 * time.Minute):
		t.Fatal("the worker did not stop within its grace period")
	}
	t.Logf("stopped %v after SIGTERM (the job was mid-encode)", time.Since(stopped).Round(time.Millisecond))

	if got := r.videoStatus(vid); got != "READY" {
		t.Fatalf("video is %s: a job that fits in the grace period must be completed", got)
	}
	if s, e := r.jobs(vid); len(s) != 1 || s[0] != "SUCCEEDED" {
		t.Fatalf("jobs: %v %v", s, e)
	}
	if r.runningJobs() != 0 {
		t.Fatal("a job was left RUNNING")
	}
	info := r.queue(t)
	if info.NumPending != 0 || info.NumAckPending != 0 || info.NumRedelivered != 0 {
		t.Fatalf("the message must be acknowledged, not redelivered: %+v", info)
	}
	if _, ok := r.objs.Get(testutil.MediaBucket, "v/"+vid.String()+"/a1/hls/master.m3u8"); !ok {
		t.Fatal("the finished output was not published")
	}
	if entries, _ := os.ReadDir(r.scr); len(entries) != 0 {
		t.Fatalf("scratch not cleaned: %v", entries)
	}
}

// A job that does not fit is cancelled after the grace period and its message goes
// back to the queue; nothing is left RUNNING and another worker finishes the video.
func TestSIGTERMReturnsALongJobToTheQueue(t *testing.T) {
	r := newStopRig(t)
	clip := testutil.MakeClip(t, r.tools, t.TempDir(), testutil.ClipLandscape) // 30 s of 1080p

	const grace = time.Second
	slow := r.consumer("slow", grace) // "slow" keeps ffmpeg busy well past the grace period
	cancel, done := run(slow)
	defer cancel()
	time.Sleep(500 * time.Millisecond)

	vid := r.submit(clip)
	st := r.subscribeStages(vid)
	waitStage(t, st, "TRANSCODING", 60*time.Second)
	time.Sleep(500 * time.Millisecond) // ffmpeg is running

	stopped := time.Now()
	cancel() // SIGTERM
	select {
	case <-done:
	case <-time.After(grace + 30*time.Second):
		t.Fatal("the worker did not stop after the grace period (systemd would SIGKILL it)")
	}
	took := time.Since(stopped)
	if took < grace {
		t.Fatalf("stopped after %v, before the %v grace period: the job was cut short", took, grace)
	}
	t.Logf("stopped %v after SIGTERM (grace %v), job was still encoding", took.Round(time.Millisecond), grace)

	// The stop left a consistent state.
	if r.runningJobs() != 0 {
		t.Fatal("a job was left RUNNING after a graceful stop")
	}
	statuses, errs := r.jobs(vid)
	if len(statuses) != 1 || statuses[0] != "FAILED" || errs[0] == "" {
		t.Fatalf("job after the stop: %v %v", statuses, errs)
	}
	if got := r.videoStatus(vid); got != "PROCESSING" {
		t.Fatalf("video is %s: an interrupted job must not fail the video (it stays PROCESSING for the retry)", got)
	}
	var failedEvents int
	_ = r.pg.Pool.QueryRow(context.Background(), `SELECT count(*) FROM media.outbox WHERE subject='video.failed'`).Scan(&failedEvents)
	if failedEvents != 0 {
		t.Fatal("a shutdown must not tell the owner that the video failed")
	}
	if keys := r.objs.Keys(testutil.MediaBucket); len(keys) != 0 {
		t.Fatalf("half-published output left in the media bucket: %v", keys)
	}
	if entries, _ := os.ReadDir(r.scr); len(entries) != 0 {
		t.Fatalf("scratch not cleaned: %v", entries)
	}

	// The message is back in the queue: a second worker picks it up and completes the video.
	second := r.consumer("ultrafast", 3*time.Minute)
	cancel2, done2 := run(second)
	defer cancel2()
	r.waitVideo(vid, "READY", 2*time.Minute)
	statuses, _ = r.jobs(vid)
	if len(statuses) != 2 || statuses[0] != "FAILED" || statuses[1] != "SUCCEEDED" {
		t.Fatalf("jobs after the retry: %v", statuses)
	}
	deadline := time.Now().Add(20 * time.Second)
	for {
		info := r.queue(t)
		if info.NumPending == 0 && info.NumAckPending == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("queue not drained: %+v", info)
		}
		time.Sleep(100 * time.Millisecond)
	}
	cancel2()
	<-done2
}
