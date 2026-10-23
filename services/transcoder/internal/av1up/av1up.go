// Package av1up adds the separate AV1 HLS set (task ENC2 phase 2, ADR-041) to the most watched READY videos.
// New videos are encoded in H.264 only; this off-peak job re-encodes the raw source of the videos whose
// playback starts over the last 7 days reach a threshold, with av1_nvenc (FFmpeg 8, AV1_FFMPEG_PATH) at the
// calibrated defaults (CQ 35, ceiling 85 % of the H.264 ladder), into v/{id}/av1/{run}/ with the same ladder
// and rendition names as the H.264 set. The set is committed in one transaction (CommitAV1); video-svc then
// returns it as Playback.hls_av1_url.
package av1up

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/hlsmaster"
	"github.com/luantpbk/winkey/services/transcoder/internal/job"
	"github.com/luantpbk/winkey/services/transcoder/internal/media"
)

// Candidate is a READY video without an AV1 set whose 7-day starts reach the threshold.
type Candidate struct {
	ID        uuid.UUID
	RawBucket string
	RawKey    string
	Starts7d  int64
	// H264Names are the rendition names of its H.264 set; the AV1 set must have exactly the same.
	H264Names []string
}

// Commit is a complete AV1 set ready to be recorded.
type Commit struct {
	VideoID      uuid.UUID
	MasterKey    string // v/{id}/av1/{run}/master.m3u8
	Renditions   []media.Rendition
	PlaylistKeys []string // PlaylistKeys[i] is Renditions[i]'s index.m3u8
}

// Store is the persistence port.
type Store interface {
	// SelectAV1 returns at most limit READY videos with no AV1 set whose analytics.video_daily starts over the
	// last 7 days are at least minStarts (0: every such video, watched or not), most watched first, then newest.
	SelectAV1(ctx context.Context, minStarts int64, limit int) ([]Candidate, error)
	// CommitAV1, in one transaction holding the video row lock: requires the video to be READY, replaces its
	// codec='av1' renditions, applies the audio group of its READY audio tracks to the AV1 master (rewrite,
	// MUX1) and stores hls_av1_master_key. previous is the master key it replaced ("" when none). ok is false
	// when the video is gone or no longer READY; nothing is written then.
	CommitAV1(ctx context.Context, c Commit, rewrite func(ctx context.Context, masterKey string, ready []hlsmaster.Track) (string, error)) (previous string, ok bool, err error)
}

// Media is the local processing port (job.Tools with the FFmpeg 8 binary).
type Media interface {
	Probe(ctx context.Context, path string) (media.Info, error)
	RunHLS(ctx context.Context, plan media.HLSPlan, durationSec float64, onProgress func(float64)) error
}

// Options of one run.
type Options struct {
	MinStarts   int64
	Limit       int
	DryRun      bool
	MediaBucket string
	ScratchDir  string
	CQ          int // 0: media.DefaultAV1CQ
	MaxratePct  int // 0: media.DefaultAV1MaxratePct
	NoHWDecode  bool
	// TopN and KeepTop are the AV1 policy (AV1POL, ADR-048); TopN = AllVideos keeps the original behaviour
	// (every video over MinStarts, nothing dropped). They apply only when Runner.Policy is set.
	TopN    int
	KeepTop int
}

// Summary is the outcome of a run.
type Summary struct {
	Selected, Done, Failed, LostRace, WouldDo int
	// Dropped AV1 sets (policy) and Swept leftover set directories deleted (sets dropped by an earlier run).
	Dropped, Swept int
	Duration       time.Duration
}

// Line is the summary line printed by the CLI.
func (s Summary) Line(dry bool) string {
	line := fmt.Sprintf("summary: selected=%d done=%d failed=%d lost_race=%d dropped=%d swept=%d",
		s.Selected, s.Done, s.Failed, s.LostRace, s.Dropped, s.Swept)
	if dry {
		line += fmt.Sprintf(" would_do=%d dry_run=true", s.WouldDo)
	}
	return line + fmt.Sprintf(" duration=%s", s.Duration.Round(time.Millisecond))
}

// Runner upgrades videos one at a time (the GPU is shared; one AV1 encode at a time is enough off-peak).
type Runner struct {
	Store   Store
	Objects job.Objects
	Media   Media
	Opt     Options
	Log     *slog.Logger
	// Policy enables the top-N policy (Opt.TopN, Opt.KeepTop); nil keeps the threshold-only behaviour.
	Policy PolicyStore
	// NewRunID names the output directory of one video (default: a UUIDv7).
	NewRunID func() string
}

// Run selects and upgrades. It returns an error only when the selection or the scratch directory fails;
// per-video failures are counted and logged. A cancelled ctx stops after the current video.
func (r *Runner) Run(ctx context.Context) (Summary, error) {
	start := time.Now()
	var sum Summary
	limit := r.Opt.Limit
	var plan PolicyPlan
	if r.Policy != nil {
		ranks, err := r.Policy.RankAV1(ctx)
		if err != nil {
			sum.Duration = time.Since(start)
			return sum, fmt.Errorf("rank: %w", err)
		}
		plan = Plan(ranks, r.Opt.TopN, KeepTop(r.Opt.TopN, r.Opt.KeepTop))
		// Sweep first: directories of sets dropped by an earlier run (never the ones dropped below).
		sum.Swept = r.sweep(ctx, plan.NoAV1)
		sum.Dropped = r.drop(ctx, plan.Drop)
		if plan.Eligible != nil {
			limit = AV1UpgradeSelectAll // filter below, keeping the most-watched order
		}
	}
	cands, err := r.Store.SelectAV1(ctx, r.Opt.MinStarts, limit)
	if err != nil {
		sum.Duration = time.Since(start)
		return sum, fmt.Errorf("select: %w", err)
	}
	if plan.Eligible != nil {
		var kept []Candidate
		for _, c := range cands {
			if plan.Eligible[c.ID] && len(kept) < r.Opt.Limit {
				kept = append(kept, c)
			}
		}
		cands = kept
	}
	sum.Selected = len(cands)
	if !r.Opt.DryRun {
		if err := os.MkdirAll(r.Opt.ScratchDir, 0o750); err != nil {
			sum.Duration = time.Since(start)
			return sum, fmt.Errorf("scratch dir: %w", err)
		}
	}
	for _, c := range cands {
		if ctx.Err() != nil {
			break
		}
		switch r.one(ctx, c) {
		case outDone:
			sum.Done++
		case outFailed:
			sum.Failed++
		case outLostRace:
			sum.LostRace++
		case outWouldDo:
			sum.WouldDo++
		}
	}
	sum.Duration = time.Since(start)
	return sum, nil
}

type outcome int

const (
	outDone outcome = iota
	outFailed
	outLostRace
	outWouldDo
	outInterrupted
)

func (r *Runner) one(ctx context.Context, c Candidate) outcome {
	log := r.Log.With("video_id", c.ID, "starts_7d", c.Starts7d)
	if r.Opt.DryRun {
		log.InfoContext(ctx, "would encode AV1", "renditions", strings.Join(c.H264Names, ","))
		return outWouldDo
	}
	started := time.Now()
	dir, err := os.MkdirTemp(r.Opt.ScratchDir, "av1-"+c.ID.String()+"-")
	if err != nil {
		return r.fail(ctx, log, "scratch", err)
	}
	defer func() { _ = os.RemoveAll(dir) }()

	src := filepath.Join(dir, "source")
	if err := r.Objects.Download(ctx, c.RawBucket, c.RawKey, src); err != nil {
		return r.fail(ctx, log, "download", err)
	}
	info, err := r.Media.Probe(ctx, src)
	if err != nil {
		return r.fail(ctx, log, "probe", err)
	}
	rs := media.Select(info.DisplayW, info.DisplayH)
	if !sameNames(rs, c.H264Names) {
		return r.fail(ctx, log, "ladder", fmt.Errorf("AV1 ladder %v differs from the H.264 set %v", names(rs), c.H264Names))
	}
	out := filepath.Join(dir, "hls-av1")
	plan := media.HLSPlan{
		Input: src, OutDir: out, Encoder: media.EncoderAV1NVENC, Renditions: rs, FPS: info.FPS, HasAudio: info.HasAudio,
		AV1CQ: r.Opt.CQ, AV1MaxratePct: r.Opt.MaxratePct, NoHWDecode: r.Opt.NoHWDecode,
	}
	if err := r.Media.RunHLS(ctx, plan, info.DurationSec, func(float64) {}); err != nil {
		return r.fail(ctx, log, "encode", err)
	}
	if err := job.NormalizeMaster(filepath.Join(out, media.MasterPlaylist)); err != nil {
		return r.fail(ctx, log, "normalize", err)
	}
	if err := r.setCodecs(ctx, out, rs); err != nil {
		return r.fail(ctx, log, "codecs", err)
	}
	if err := media.VerifyOutput(out, rs); err != nil {
		return r.fail(ctx, log, "verify", err)
	}

	runID := uuid.Must(uuid.NewV7()).String()
	if r.NewRunID != nil {
		runID = r.NewRunID()
	}
	prefix := fmt.Sprintf("v/%s/av1/%s/", c.ID, runID)
	if err := r.upload(ctx, out, prefix); err != nil {
		r.cleanup(prefix, log)
		return r.fail(ctx, log, "upload", err)
	}
	commit := Commit{VideoID: c.ID, MasterKey: prefix + media.MasterPlaylist}
	pct := r.Opt.MaxratePct
	if pct == 0 {
		pct = media.DefaultAV1MaxratePct
	}
	for _, rd := range rs {
		rd.TargetK = rd.TargetK * pct / 100 // bitrate_kbps of an AV1 rendition is its ceiling
		commit.Renditions = append(commit.Renditions, rd)
		commit.PlaylistKeys = append(commit.PlaylistKeys, prefix+rd.Name+"/index.m3u8")
	}
	localMaster := filepath.Join(out, media.MasterPlaylist)
	previous, ok, err := r.Store.CommitAV1(ctx, commit, func(ctx context.Context, masterKey string, ready []hlsmaster.Track) (string, error) {
		return job.RewriteMasterFile(ctx, r.Objects, r.Opt.MediaBucket, localMaster, masterKey, ready)
	})
	if err != nil {
		r.cleanup(prefix, log)
		return r.fail(ctx, log, "commit", err)
	}
	if !ok {
		log.WarnContext(ctx, "video no longer READY (deleted or re-encoding); discarding the AV1 set")
		r.cleanup(prefix, log)
		return outLostRace
	}
	if previous != "" {
		if old := path.Dir(previous) + "/"; old != prefix {
			r.cleanup(old, log) // a concurrent run's set, replaced by this one
		}
	}
	log.InfoContext(ctx, "AV1 set ready", "master_key", commit.MasterKey, "renditions", len(rs),
		"encode_seconds", time.Since(started).Seconds())
	return outDone
}

// setCodecs writes CODECS into the AV1 master, which FFmpeg's HLS muxer leaves out for AV1: each variant's
// av01 string comes from probing that variant's own playlist (profile, level, bit depth), plus the AAC of the
// audio rendition every variant plays with.
func (r *Runner) setCodecs(ctx context.Context, out string, rs []media.Rendition) error {
	codecs := map[string]string{}
	for _, rd := range rs {
		info, err := r.Media.Probe(ctx, filepath.Join(out, rd.Name, "index.m3u8"))
		if err != nil {
			return fmt.Errorf("probe %s: %w", rd.Name, err)
		}
		c, err := media.AV1Codec(info)
		if err != nil {
			return fmt.Errorf("%s: %w", rd.Name, err)
		}
		// The variants are video-only; their audio is the group's AAC rendition (ADR-042 addendum).
		c += "," + media.AACCodec
		codecs[rd.Name] = c
	}
	path := filepath.Join(out, media.MasterPlaylist)
	data, err := os.ReadFile(path) // #nosec G304 -- the master ffmpeg just wrote in our scratch dir
	if err != nil {
		return err
	}
	data, err = media.SetMasterCodecs(data, codecs)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

// upload sends every file of out to prefix: segments first, then the media playlists, the master last, so no
// playlist is visible before what it lists.
func (r *Runner) upload(ctx context.Context, out, prefix string) error {
	var segs, lists []string
	err := filepath.WalkDir(out, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, err := filepath.Rel(out, p)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		switch {
		case strings.HasSuffix(rel, ".tmp"):
		case rel == media.MasterPlaylist:
		case strings.HasSuffix(rel, ".m3u8"):
			lists = append(lists, rel)
		default:
			segs = append(segs, rel)
		}
		return nil
	})
	if err != nil {
		return err
	}
	sort.Strings(segs)
	sort.Strings(lists)
	for _, rel := range append(append(segs, lists...), media.MasterPlaylist) {
		ct := "video/mp4"
		if strings.HasSuffix(rel, ".m3u8") {
			ct = hlsmaster.ContentType
		}
		if err := r.Objects.UploadFile(ctx, r.Opt.MediaBucket, prefix+rel, filepath.Join(out, filepath.FromSlash(rel)), ct, job.CacheImmutable); err != nil {
			return fmt.Errorf("upload %s: %w", rel, err)
		}
	}
	return nil
}

func (r *Runner) fail(ctx context.Context, log *slog.Logger, step string, err error) outcome {
	if ctx.Err() != nil && errors.Is(err, ctx.Err()) {
		log.WarnContext(ctx, "interrupted", "step", step)
		return outInterrupted
	}
	log.ErrorContext(ctx, "AV1 upgrade failed", "step", step, "error", err)
	return outFailed
}

// AV1UpgradeSelectAll is the selection limit used when the policy filters the candidates itself.
const AV1UpgradeSelectAll = 100000

// drop forgets the AV1 sets of the given videos (objects stay until the next run's sweep).
func (r *Runner) drop(ctx context.Context, ids []uuid.UUID) int {
	n := 0
	for _, id := range ids {
		if ctx.Err() != nil {
			break
		}
		if r.Opt.DryRun {
			r.Log.InfoContext(ctx, "would drop AV1 set", "video_id", id)
			n++
			continue
		}
		ok, err := r.Policy.DropAV1(ctx, id)
		if err != nil {
			r.Log.ErrorContext(ctx, "drop AV1 set failed", "video_id", id, "error", err)
			continue
		}
		if ok {
			r.Log.InfoContext(ctx, "AV1 set dropped (objects deleted by the next run)", "video_id", id)
			n++
		}
	}
	return n
}

// sweep deletes the av1/{run}/ directories of READY videos that have no AV1 set (dropped by an earlier run).
func (r *Runner) sweep(ctx context.Context, ids []uuid.UUID) int {
	n := 0
	for _, id := range ids {
		if ctx.Err() != nil {
			break
		}
		prefix := "v/" + id.String() + "/av1/"
		dirs, err := r.Objects.ListPrefixes(ctx, r.Opt.MediaBucket, prefix)
		if err != nil {
			r.Log.WarnContext(ctx, "list leftover AV1 sets failed", "video_id", id, "error", err)
			continue
		}
		for _, d := range dirs {
			if !strings.HasPrefix(d, prefix) || d == prefix {
				continue
			}
			if r.Opt.DryRun {
				r.Log.InfoContext(ctx, "would delete leftover AV1 set", "prefix", d)
				n++
				continue
			}
			if err := r.Objects.DeletePrefix(ctx, r.Opt.MediaBucket, d); err != nil {
				r.Log.WarnContext(ctx, "delete leftover AV1 set failed", "prefix", d, "error", err)
				continue
			}
			n++
		}
	}
	return n
}

// cleanup removes an uploaded set on a fresh context (the run context may be cancelled).
func (r *Runner) cleanup(prefix string, log *slog.Logger) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if err := r.Objects.DeletePrefix(ctx, r.Opt.MediaBucket, prefix); err != nil {
		log.Warn("cleanup of the AV1 set failed", "prefix", prefix, "error", err)
	}
}

func names(rs []media.Rendition) []string {
	out := make([]string, 0, len(rs))
	for _, r := range rs {
		out = append(out, r.Name)
	}
	return out
}

func sameNames(rs []media.Rendition, h264 []string) bool {
	a, b := names(rs), append([]string(nil), h264...)
	sort.Strings(a)
	sort.Strings(b)
	return strings.Join(a, ",") == strings.Join(b, ",")
}
