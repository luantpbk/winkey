package job

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/services/transcoder/internal/media"
)

// UploadedEvent is the `data` of video.uploaded.
type UploadedEvent struct {
	VideoID     string `json:"video_id"`
	OwnerID     string `json:"owner_id"`
	RawBucket   string `json:"raw_bucket"`
	RawKey      string `json:"raw_key"`
	SizeBytes   int64  `json:"size_bytes"`
	ContentType string `json:"content_type"`
}

// Video is the subset of media.videos the transcoder reads.
type Video struct {
	ID        uuid.UUID
	OwnerID   uuid.UUID
	Status    string
	RawBucket string
	RawKey    string
}

// BeginResult is the outcome of Store.BeginJob.
type BeginResult struct {
	// Skip is true when there is nothing to do: the video is already READY or
	// no longer exists. The message is acked.
	Skip    bool
	Video   Video
	JobID   uuid.UUID
	Attempt int
}

// ReadyResult carries everything written when a job succeeds.
type ReadyResult struct {
	VideoID    uuid.UUID
	OwnerID    uuid.UUID
	JobID      uuid.UUID
	Attempt    int
	Encoder    string
	DurationMs int
	Width      int // of the top rendition
	Height     int
	MasterKey  string
	ThumbKey   string
	// StoryboardKey is the key of storyboard.vtt; "" when the storyboard could not be made
	// (best effort): media.videos.storyboard_key and the video.ready field are then null.
	StoryboardKey string
	Renditions    []media.Rendition
	// PlaylistKeys[i] is the media-bucket key of Renditions[i]'s playlist.
	PlaylistKeys []string
}

// FailRecord describes a failed attempt.
type FailRecord struct {
	VideoID uuid.UUID
	OwnerID uuid.UUID
	JobID   uuid.UUID
	Attempt int
	Failure Failure
	// Terminal marks the video FAILED and emits video.failed. When false the
	// job is FAILED but the video stays PROCESSING for the retry.
	Terminal bool
}

// Store is the persistence port (media.videos, transcode_jobs, renditions,
// outbox).
type Store interface {
	// BeginJob, in one transaction: locks the video; skips READY/missing;
	// moves UPLOADED|FAILED|PROCESSING → PROCESSING; fails any stale active job
	// (crashed worker); inserts a RUNNING job with attempt = max(attempt)+1.
	BeginJob(ctx context.Context, videoID uuid.UUID, encoder, workerID string) (BeginResult, error)
	SetJobEncoder(ctx context.Context, jobID uuid.UUID, encoder string) error
	SetProgress(ctx context.Context, jobID uuid.UUID, percent float64) error
	// Complete, in one transaction: replaces renditions, sets metadata and keys,
	// PROCESSING→READY, published_at = coalesce(published_at, now()), job
	// SUCCEEDED, video.ready into the outbox. ok is false if the video is no
	// longer PROCESSING (deleted meanwhile); nothing is written then.
	Complete(ctx context.Context, r ReadyResult) (ok bool, err error)
	// FailJob records the failure; see FailRecord.Terminal.
	FailJob(ctx context.Context, f FailRecord) error
	// FailStuck is used when JetStream gave up on a message (max_deliver
	// reached without an ack, typically because workers died mid-job). In one
	// transaction, if the video is still PROCESSING or UPLOADED: closes its
	// active job (or records a FAILED one if none ever ran), marks the video
	// FAILED and writes video.failed to the outbox. ok is false when there was
	// nothing to do (already READY/FAILED, deleted): the call is idempotent.
	FailStuck(ctx context.Context, videoID uuid.UUID, f Failure) (rec FailRecord, ok bool, err error)
	// Heartbeat stamps transcode_jobs.heartbeat_at = now() for a running job.
	Heartbeat(ctx context.Context, jobID uuid.UUID) error
	// ReconcileStale handles RUNNING jobs whose worker is gone: those with
	// coalesce(heartbeat_at, started_at) older than staleAfter. Each is marked
	// FAILED ("worker lost (no heartbeat)"). If the video is still PROCESSING
	// and the job's attempt is below maxAttempts, a new video.uploaded (fresh
	// event_id, same data) is enqueued in the same transaction; otherwise the
	// video is failed like FailStuck (FAILED + video.failed). Safe to call from
	// several workers at once: every job is handled exactly once.
	ReconcileStale(ctx context.Context, staleAfter time.Duration, maxAttempts, limit int) ([]Reconciled, error)
}

// Reconciled reports what ReconcileStale did with one lost job.
type Reconciled struct {
	VideoID uuid.UUID
	JobID   uuid.UUID
	Attempt int
	// Retried is true when a new video.uploaded was enqueued; false when the
	// video was failed (attempts exhausted) or was no longer PROCESSING.
	Retried bool
	Failed  bool
}

// GaveUpFailure is recorded for videos whose processing was abandoned: JetStream
// exhausted max_deliver, or the reconciler ran out of attempts.
var GaveUpFailure = Failure{
	Reason:    ReasonInternal,
	Retryable: true, // a human can reset or replay it once the cause is fixed
	Message:   "Processing did not complete after several attempts.",
}

// Objects is the object-storage port.
type Objects interface {
	Download(ctx context.Context, bucket, key, dstPath string) error
	UploadFile(ctx context.Context, bucket, key, srcPath, contentType, cacheControl string) error
	// DeletePrefix removes every object whose key starts with prefix.
	DeletePrefix(ctx context.Context, bucket, prefix string) error
	DeleteObject(ctx context.Context, bucket, key string) error
	// ListPrefixes lists the immediate "sub-directories" under prefix
	// (S3 CommonPrefixes with delimiter "/"), each ending in "/".
	ListPrefixes(ctx context.Context, bucket, prefix string) ([]string, error)
}

// Events publishes ephemeral core-NATS messages (progress).
type Events interface {
	Publish(subject string, data []byte) error
}
