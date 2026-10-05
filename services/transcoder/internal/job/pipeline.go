package job

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"golang.org/x/sync/errgroup"

	"github.com/luantpbk/winkey/libs/go/outbox"
	"github.com/luantpbk/winkey/services/transcoder/internal/media"
)

// Pipeline settings.
type Config struct {
	ScratchDir        string // fast local disk (NVMe); one sub-directory per job
	ArchiveDir        string // optional: raw copy at ArchiveDir/{owner}/{video}/source
	MediaBucket       string
	Encoder           string // resolved: media.EncoderNVENC or media.EncoderX264
	X264Preset        string
	NoHWDecode        bool // NVENC with CPU decode instead of -hwaccel cuda (benchmarks; possible HWACCEL_DECODE=false)
	UploadParallelism int  // default 8
	WorkerID          string
	ProgressInterval  time.Duration // default 5s
	HeartbeatEvery    time.Duration // InProgress + heartbeat_at interval; default 30s
}

// Pipeline processes one video.uploaded message.
type Pipeline struct {
	Store   Store
	Objects Objects
	Events  Events
	Tools   Tools
	Cfg     Config
	Log     *slog.Logger
	// Storyboard replaces Tools.Storyboard (tests). nil = use ffmpeg.
	Storyboard StoryboardFunc
}

// Delivery describes which delivery of the message this is.
type Delivery struct {
	Num int // NumDelivered, starting at 1
	Max int // consumer max_deliver
	// InProgress extends the message's ack deadline (msg.InProgress). The
	// pipeline calls it every Config.HeartbeatEvery while a job runs, and
	// records the same tick in transcode_jobs.heartbeat_at. May be nil.
	InProgress func() error
}

// Last reports whether no further delivery will follow.
func (d Delivery) Last() bool { return d.Max > 0 && d.Num >= d.Max }

// Action tells the consumer what to do with the message.
type Action int

const (
	ActionAck Action = iota
	ActionNak        // NakWithDelay(Delay)
	ActionTerm
	ActionTermDLQ // Term and copy the message to dlq.video.uploaded
)

// Result is the outcome of Process.
type Result struct {
	Action Action
	Delay  time.Duration
	Err    error // failure that led to Nak/Term, for logging
	// Stats of a successful run.
	Stats *Stats
	// Steps are the timed steps that ran (V4-a), in the order they finished, whether or not the job
	// succeeded; empty when the job never started (nothing to do, begin failed).
	Steps []StepTiming
}

// Stats describe a successful transcode (used for benchmarks and metrics).
type Stats struct {
	Encoder     string
	MediaSec    float64
	EncodeWall  time.Duration
	TotalWall   time.Duration
	Renditions  int
	UploadBytes int64
	// JobWall is the time from the start of the download to the video being READY (V4-a); 0 when the
	// video was not made READY (it was deleted meanwhile).
	JobWall time.Duration
	// Storyboard is true when the seek-preview storyboard was produced; StoryboardWall is
	// what the step cost (V5a), whether or not it succeeded.
	Storyboard     bool
	StoryboardWall time.Duration
}

// XRealtime is media seconds encoded per wall second.
func (s Stats) XRealtime() float64 {
	if s.EncodeWall <= 0 {
		return 0
	}
	return s.MediaSec / s.EncodeWall.Seconds()
}

// Overall progress weights of the stages (percent of the whole job).
const (
	progressProbe     = 5.0
	progressTranscode = 5.0  // start
	progressUpload    = 90.0 // transcode occupies 5..90
	progressDone      = 99.0 // upload occupies 90..99; 100 is written on success
)

// Stage names of video.progress.schema.json.
const (
	StageDownloading  = "DOWNLOADING"
	StageProbing      = "PROBING"
	StageTranscoding  = "TRANSCODING"
	StageUploading    = "UPLOADING"
	cacheControlValue = "public, max-age=31536000, immutable"
)

// Process runs one message to completion. It never returns an error: every
// outcome is expressed as a Result so the consumer only maps it to
// ack/nak/term.
func (p *Pipeline) Process(ctx context.Context, ev UploadedEvent, d Delivery) Result {
	log := p.Log.With("video_id", ev.VideoID, "delivery", d.Num)
	videoID, err := uuid.Parse(ev.VideoID)
	if err != nil {
		log.ErrorContext(ctx, "video.uploaded with invalid video_id; dropping")
		return Result{Action: ActionTerm, Err: err}
	}

	start := time.Now()
	begin, err := p.Store.BeginJob(ctx, videoID, p.Cfg.Encoder, p.Cfg.WorkerID)
	if err != nil {
		log.ErrorContext(ctx, "begin job failed", "error", err)
		return p.retryOrGiveUp(d, err)
	}
	if begin.Skip {
		log.InfoContext(ctx, "nothing to do (video READY or gone); acking")
		return Result{Action: ActionAck}
	}
	log = log.With("job_id", begin.JobID, "attempt", begin.Attempt)

	stopHeartbeat := p.startHeartbeat(ctx, d, begin.JobID, log)
	tm := &timings{}
	stats, runErr := p.run(ctx, begin, log, tm)
	stopHeartbeat()
	steps := tm.snapshot()
	if runErr == nil {
		stats.TotalWall = time.Since(start)
		// The one summary line of the job: the stage durations in seconds beside what the job made.
		log.InfoContext(ctx, "transcode succeeded", "encoder", stats.Encoder,
			"media_sec", stats.MediaSec, "renditions", stats.Renditions, "upload_bytes", stats.UploadBytes,
			"job_seconds", stats.JobWall.Round(time.Millisecond).Seconds(),
			"encode_wall", stats.EncodeWall.Round(time.Millisecond).String(),
			"x_realtime", fmt.Sprintf("%.1f", stats.XRealtime()), stageSeconds(steps))
		return Result{Action: ActionAck, Stats: &stats, Steps: steps}
	}

	// Shutdown: give the job back without blaming the video.
	if ctx.Err() != nil && errors.Is(runErr, ctx.Err()) {
		fr := FailRecord{VideoID: videoID, OwnerID: begin.Video.OwnerID, JobID: begin.JobID, Attempt: begin.Attempt,
			Failure: Failure{Reason: ReasonInternal, Retryable: true, Message: "Worker shutting down."}}
		if err := p.Store.FailJob(context.WithoutCancel(ctx), fr); err != nil {
			log.ErrorContext(ctx, "record interrupted job", "error", err)
		}
		log.WarnContext(ctx, "interrupted by shutdown; nak", stageSeconds(steps))
		return Result{Action: ActionNak, Err: ErrInterrupted, Steps: steps}
	}

	f := Classify(runErr)
	terminal := !f.Retryable || d.Last()
	log.ErrorContext(ctx, "transcode failed", "reason", f.Reason, "retryable", f.Retryable,
		"terminal", terminal, "error", runErr, stageSeconds(steps))
	rec := FailRecord{VideoID: videoID, OwnerID: begin.Video.OwnerID, JobID: begin.JobID,
		Attempt: begin.Attempt, Failure: f, Terminal: terminal}
	if err := p.Store.FailJob(context.WithoutCancel(ctx), rec); err != nil {
		log.ErrorContext(ctx, "record failure", "error", err)
		// The DB is unreachable: let JetStream redeliver rather than lose the job.
		return Result{Action: ActionNak, Delay: retryDelay(d), Err: runErr, Steps: steps}
	}
	switch {
	case !f.Retryable:
		return Result{Action: ActionTerm, Err: runErr, Steps: steps}
	case d.Last():
		return Result{Action: ActionTermDLQ, Err: runErr, Steps: steps}
	default:
		return Result{Action: ActionNak, Delay: retryDelay(d), Err: runErr, Steps: steps}
	}
}

// startHeartbeat, every HeartbeatEvery, extends the message's ack deadline
// (InProgress) and stamps transcode_jobs.heartbeat_at, which the stuck-job
// reconciler reads to tell a live job from one whose worker died. It returns
// a function that stops the loop and waits for it.
func (p *Pipeline) startHeartbeat(ctx context.Context, d Delivery, jobID uuid.UUID, log *slog.Logger) (stop func()) {
	every := p.Cfg.HeartbeatEvery
	if every <= 0 {
		every = 30 * time.Second
	}
	hbCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		t := time.NewTicker(every)
		defer t.Stop()
		for {
			select {
			case <-hbCtx.Done():
				return
			case <-t.C:
				if d.InProgress != nil {
					if err := d.InProgress(); err != nil {
						log.WarnContext(hbCtx, "InProgress failed", "error", err)
					}
				}
				if err := p.Store.Heartbeat(hbCtx, jobID); err != nil && hbCtx.Err() == nil {
					log.WarnContext(hbCtx, "heartbeat write failed", "error", err)
				}
			}
		}
	}()
	return func() { cancel(); <-done }
}

// retryOrGiveUp handles failures before a job exists (e.g. database down).
func (p *Pipeline) retryOrGiveUp(d Delivery, err error) Result {
	if d.Last() {
		return Result{Action: ActionTermDLQ, Err: err}
	}
	return Result{Action: ActionNak, Delay: retryDelay(d), Err: err}
}

// retryDelay is 1 minute × delivery number (contracts/events/README.md).
func retryDelay(d Delivery) time.Duration {
	return time.Minute * time.Duration(max(1, d.Num))
}

// run executes steps 2-8 of the job and records the duration of each timed step in tm.
func (p *Pipeline) run(ctx context.Context, b BeginResult, log *slog.Logger, tm *timings) (Stats, error) {
	v := b.Video
	work := filepath.Join(p.Cfg.ScratchDir, fmt.Sprintf("%s-a%d", v.ID, b.Attempt))
	if err := os.RemoveAll(work); err != nil {
		return Stats{}, fmt.Errorf("clean scratch: %w", err)
	}
	if err := os.MkdirAll(work, 0o755); err != nil {
		return Stats{}, fmt.Errorf("create scratch: %w", err)
	}
	defer func() { _ = os.RemoveAll(work) }()

	rep := p.newReporter(v, b.JobID)
	source := filepath.Join(work, "source")

	// 2. Download (and archive) the raw object.
	jobStart := time.Now()
	rep.report(ctx, StageDownloading, 0)
	if err := tm.time(StepDownload, func() error { return p.Objects.Download(ctx, v.RawBucket, v.RawKey, source) }); err != nil {
		return Stats{}, &StorageError{Op: "download", Err: err}
	}
	if p.Cfg.ArchiveDir != "" {
		// The archive is a convenience copy; do not fail the video for it.
		if err := tm.time(StepArchive, func() error { return archive(source, p.Cfg.ArchiveDir, v) }); err != nil {
			log.ErrorContext(ctx, "archive raw copy failed", "error", err)
		}
	}

	// 3. Probe.
	rep.report(ctx, StageProbing, progressProbe)
	var info media.Info
	if err := tm.time(StepProbe, func() (err error) { info, err = p.Tools.Probe(ctx, source); return }); err != nil {
		return Stats{}, err
	}

	// 4-5. Ladder and encode (NVENC falls back to x264 within the attempt).
	rs := media.Select(info.DisplayW, info.DisplayH)
	outDir := filepath.Join(work, "out")
	hlsDir := filepath.Join(outDir, "hls")
	encoder := p.Cfg.Encoder
	encStart := time.Now()
	encode := func(enc string) error {
		if err := os.RemoveAll(hlsDir); err != nil {
			return err
		}
		return p.Tools.RunHLS(ctx, media.HLSPlan{
			Input: source, OutDir: hlsDir, Encoder: enc, X264Preset: p.Cfg.X264Preset,
			Renditions: rs, FPS: info.FPS, HasAudio: info.HasAudio, NoHWDecode: p.Cfg.NoHWDecode,
		}, info.DurationSec, func(pct float64) {
			rep.report(ctx, StageTranscoding, progressTranscode+(progressUpload-progressTranscode)*pct/100)
		})
	}
	rep.report(ctx, StageTranscoding, progressTranscode)
	err := encode(encoder)
	var ee *EncoderError
	if err != nil && encoder == media.EncoderNVENC && errors.As(err, &ee) {
		log.WarnContext(ctx, "nvenc failed; retrying with x264 in the same attempt", "error", err)
		encoder = media.EncoderX264
		if serr := p.Store.SetJobEncoder(ctx, b.JobID, encoder); serr != nil {
			return Stats{}, serr
		}
		err = encode(encoder)
	}
	encodeWall := time.Since(encStart)
	tm.add(StepEncode, encodeWall, err != nil)
	if err != nil {
		return Stats{}, err
	}
	if err := media.VerifyOutput(hlsDir, rs); err != nil {
		return Stats{}, &EncoderError{Op: "verify output", Err: err}
	}

	// 6. Poster at 10% of the duration.
	poster := filepath.Join(outDir, "thumb", "poster.jpg")
	if err := tm.time(StepPoster, func() error { return p.Tools.Thumbnail(ctx, source, poster, info.DurationSec*0.1) }); err != nil {
		return Stats{}, err
	}

	// 6b. Seek-preview storyboard (V5a): best effort, the video is READY without it. It reads the
	// smallest HLS rendition on the CPU (or the source when none qualifies), which keeps it cheap.
	prefix := fmt.Sprintf("v/%s/a%d/", v.ID, b.Attempt)
	storyboardKey, storyboardWall, err := p.buildStoryboard(ctx, storyboardInput(rs, hlsDir, source), outDir, prefix, info.DurationSec, log)
	// The step counts as failed when there is no storyboard: the job goes on, the metric shows it.
	tm.add(StepStoryboard, storyboardWall, err != nil || storyboardKey == "")
	if err != nil {
		return Stats{}, err
	}

	// 7. Upload under v/{video_id}/a{attempt}/.
	rep.report(ctx, StageUploading, progressUpload)
	var bytes int64
	err = tm.time(StepUpload, func() (err error) {
		bytes, err = p.uploadAll(ctx, outDir, prefix, func(frac float64) {
			rep.report(ctx, StageUploading, progressUpload+(progressDone-progressUpload)*frac)
		})
		return
	})
	if err != nil {
		p.cleanupPrefix(prefix, v, log)
		return Stats{}, err
	}

	// 8. One transaction: READY.
	res := ReadyResult{
		VideoID: v.ID, OwnerID: v.OwnerID, JobID: b.JobID, Attempt: b.Attempt, Encoder: encoder,
		DurationMs: max(1, int(info.DurationSec*1000+0.5)),
		Width:      rs[0].Width, Height: rs[0].Height,
		MasterKey:  prefix + "hls/" + media.MasterPlaylist,
		ThumbKey:   prefix + "thumb/poster.jpg",
		Renditions: rs, StoryboardKey: storyboardKey,
	}
	for _, r := range rs {
		res.PlaylistKeys = append(res.PlaylistKeys, prefix+"hls/"+r.Name+"/index.m3u8")
	}
	var ok bool
	err = tm.time(StepCommit, func() (err error) { ok, err = p.Store.Complete(ctx, res); return })
	jobWall := time.Since(jobStart)
	if err != nil {
		p.cleanupPrefix(prefix, v, log)
		return Stats{}, err
	}
	if !ok {
		log.WarnContext(ctx, "video no longer PROCESSING (deleted?); discarding output")
		p.cleanupPrefix(prefix, v, log)
		return Stats{Encoder: encoder}, nil
	}
	rep.reportForce(ctx, StageUploading, 100)

	// After READY: drop the output of older attempts (V3 hygiene).
	if err := p.RemoveOldAttempts(ctx, v.ID, b.Attempt); err != nil {
		log.WarnContext(ctx, "remove old attempts", "error", err)
	}
	return Stats{
		Encoder: encoder, MediaSec: info.DurationSec, EncodeWall: encodeWall,
		Renditions: len(rs), UploadBytes: bytes, JobWall: jobWall,
		Storyboard: storyboardKey != "", StoryboardWall: storyboardWall,
	}, nil
}

var attemptRe = regexp.MustCompile(`^a(\d+)/$`)

// RemoveOldAttempts deletes v/{video_id}/a{k}/ for every k < keep.
func (p *Pipeline) RemoveOldAttempts(ctx context.Context, videoID uuid.UUID, keep int) error {
	base := fmt.Sprintf("v/%s/", videoID)
	subs, err := p.Objects.ListPrefixes(ctx, p.Cfg.MediaBucket, base)
	if err != nil {
		return err
	}
	var errs []error
	for _, sub := range subs {
		m := attemptRe.FindStringSubmatch(strings.TrimPrefix(sub, base))
		if m == nil {
			continue
		}
		if n, _ := strconv.Atoi(m[1]); n < keep {
			if err := p.Objects.DeletePrefix(ctx, p.Cfg.MediaBucket, sub); err != nil {
				errs = append(errs, err)
			}
		}
	}
	return errors.Join(errs...)
}

// cleanupPrefix removes a partially uploaded attempt; it runs on a fresh
// context because the job context may already be cancelled.
func (p *Pipeline) cleanupPrefix(prefix string, v Video, log *slog.Logger) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if err := p.Objects.DeletePrefix(ctx, p.Cfg.MediaBucket, prefix); err != nil {
		log.Warn("cleanup partial upload", "prefix", prefix, "error", err)
	}
}

// uploadAll uploads every file below outDir (hls/..., thumb/... and storyboard/...) keeping
// the relative layout under prefix. The master playlist goes last so a
// half-uploaded attempt never exposes a playable master.
func (p *Pipeline) uploadAll(ctx context.Context, outDir, prefix string, onFrac func(float64)) (int64, error) {
	type file struct {
		rel  string
		path string
		size int64
	}
	var files []file
	var master *file
	err := filepath.WalkDir(outDir, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(outDir, p)
		info, err := d.Info()
		if err != nil {
			return err
		}
		f := file{rel: filepath.ToSlash(rel), path: p, size: info.Size()}
		if f.rel == "hls/"+media.MasterPlaylist {
			master = &f
			return nil
		}
		files = append(files, f)
		return nil
	})
	if err != nil {
		return 0, err
	}
	if master == nil {
		return 0, &EncoderError{Op: "collect output", Err: errors.New("master playlist missing")}
	}

	par := p.Cfg.UploadParallelism
	if par <= 0 {
		par = 8
	}
	var mu sync.Mutex
	var done, total int64
	for _, f := range files {
		total += f.size
	}
	total += master.size
	bump := func(n int64) {
		mu.Lock()
		done += n
		frac := float64(done) / float64(max(total, 1))
		mu.Unlock()
		onFrac(frac)
	}
	up := func(ctx context.Context, f file) error {
		if err := p.Objects.UploadFile(ctx, p.Cfg.MediaBucket, prefix+f.rel, f.path, contentType(f.rel), cacheControlValue); err != nil {
			return &StorageError{Op: "upload " + path.Base(f.rel), Err: err}
		}
		bump(f.size)
		return nil
	}

	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(par)
	for _, f := range files {
		g.Go(func() error { return up(gctx, f) })
	}
	if err := g.Wait(); err != nil {
		return 0, err
	}
	if err := up(ctx, *master); err != nil {
		return 0, err
	}
	return total, nil
}

// contentType maps output files to the types the media cache must serve.
func contentType(rel string) string {
	switch strings.ToLower(path.Ext(rel)) {
	case ".m3u8":
		return "application/vnd.apple.mpegurl"
	case ".m4s", ".mp4":
		return "video/mp4"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".vtt":
		return "text/vtt"
	}
	if t := mime.TypeByExtension(path.Ext(rel)); t != "" {
		return t
	}
	return "application/octet-stream"
}

// archive copies the raw file to ArchiveDir/{owner}/{video}/source atomically.
func archive(src, dir string, v Video) error {
	dst := filepath.Join(dir, v.OwnerID.String(), v.ID.String(), "source")
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".part"
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, dst)
}

// --- progress reporting ------------------------------------------------

type reporter struct {
	p        *Pipeline
	video    Video
	jobID    uuid.UUID
	mu       sync.Mutex
	last     time.Time
	interval time.Duration
}

func (p *Pipeline) newReporter(v Video, jobID uuid.UUID) *reporter {
	iv := p.Cfg.ProgressInterval
	if iv <= 0 {
		iv = 5 * time.Second
	}
	return &reporter{p: p, video: v, jobID: jobID, interval: iv}
}

// report writes progress (job-overall percent) to the DB and core NATS at most
// once per interval; skipped calls are dropped.
func (r *reporter) report(ctx context.Context, stage string, percent float64) {
	r.mu.Lock()
	if !r.last.IsZero() && time.Since(r.last) < r.interval {
		r.mu.Unlock()
		return
	}
	r.last = time.Now()
	r.mu.Unlock()
	r.send(ctx, stage, percent)
}

func (r *reporter) reportForce(ctx context.Context, stage string, percent float64) {
	r.mu.Lock()
	r.last = time.Now()
	r.mu.Unlock()
	r.send(ctx, stage, percent)
}

func (r *reporter) send(ctx context.Context, stage string, percent float64) {
	percent = max(0, min(100, percent))
	// Progress is best effort: the terminal state is in the DB transaction.
	if err := r.p.Store.SetProgress(ctx, r.jobID, percent); err != nil {
		r.p.Log.WarnContext(ctx, "write progress", "error", err)
	}
	if r.p.Events == nil {
		return
	}
	_, payload, err := outbox.BuildEnvelope(ctx, "video.progress", map[string]any{
		"video_id": r.video.ID.String(), "owner_id": r.video.OwnerID.String(),
		"job_id": r.jobID.String(), "stage": stage, "percent": round1(percent),
	})
	if err == nil {
		err = r.p.Events.Publish(fmt.Sprintf("rt.video.%s.progress", r.video.ID), payload)
	}
	if err != nil {
		r.p.Log.WarnContext(ctx, "publish progress", "error", err)
	}
}

func round1(f float64) float64 { return float64(int(f*10+0.5)) / 10 }
