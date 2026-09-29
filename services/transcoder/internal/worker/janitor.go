package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/nats-io/nats.go/jetstream"

	"github.com/luantpbk/winkey/libs/go/outbox"
	"github.com/luantpbk/winkey/services/transcoder/internal/job"
)

// Media janitor consumer parameters.
const (
	JanitorConsumer = "media-janitor"
	SubjectDeleted  = "video.deleted"
)

// deletedEvent is the `data` of video.deleted.
type deletedEvent struct {
	VideoID     string `json:"video_id"`
	OwnerID     string `json:"owner_id"`
	RawBucket   string `json:"raw_bucket"`
	RawKey      string `json:"raw_key"`
	MediaBucket string `json:"media_bucket"`
	MediaPrefix string `json:"media_prefix"`
}

// Janitor consumes video.deleted and removes every object of the video:
// everything under media_prefix (all attempts) plus the raw object. It is
// idempotent, so redelivery is harmless.
type Janitor struct {
	JS          jetstream.JetStream
	Objects     job.Objects
	MediaBucket string // configured media bucket; events naming another bucket are refused
	RawBucket   string
	Log         *slog.Logger
}

// Run blocks until ctx is cancelled.
func (j *Janitor) Run(ctx context.Context) error {
	cons, err := j.JS.CreateOrUpdateConsumer(ctx, StreamVideo, jetstream.ConsumerConfig{
		Durable:       JanitorConsumer,
		FilterSubject: SubjectDeleted,
		AckPolicy:     jetstream.AckExplicitPolicy,
		AckWait:       5 * time.Minute,
		MaxDeliver:    10,
	})
	if err != nil {
		return fmt.Errorf("create media-janitor consumer: %w", err)
	}
	for ctx.Err() == nil {
		batch, err := cons.Fetch(10, jetstream.FetchMaxWait(fetchWait))
		if err != nil {
			j.Log.Warn("janitor fetch failed", "error", err)
			sleep(ctx, time.Second)
			continue
		}
		for msg := range batch.Messages() {
			j.handle(ctx, msg)
		}
	}
	return nil
}

func (j *Janitor) handle(ctx context.Context, msg jetstream.Msg) {
	var env outbox.Envelope
	var ev deletedEvent
	if err := json.Unmarshal(msg.Data(), &env); err != nil || env.Type != SubjectDeleted ||
		json.Unmarshal(env.Data, &ev) != nil {
		j.Log.Error("malformed video.deleted; terminating", "error", err)
		_ = msg.Term()
		return
	}
	if err := j.Validate(ev); err != nil {
		// Never delete on the say-so of an event that does not match our layout.
		j.Log.Error("refusing video.deleted", "video_id", ev.VideoID, "error", err)
		_ = msg.Term()
		return
	}
	if err := j.Purge(ctx, ev); err != nil {
		j.Log.Error("purge failed; will retry", "video_id", ev.VideoID, "error", err)
		_ = msg.NakWithDelay(30 * time.Second)
		return
	}
	j.Log.Info("purged deleted video", "video_id", ev.VideoID)
	_ = msg.Ack()
}

var uuidRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// Validate checks that the event only names objects that belong to the video
// under the documented layout, so a malformed event cannot delete anything
// else: media prefix `v/{video_id}/`, raw key `{owner_id}/{video_id}/source`,
// and the configured buckets.
func (j *Janitor) Validate(ev deletedEvent) error {
	switch {
	case !uuidRe.MatchString(ev.VideoID) || !uuidRe.MatchString(ev.OwnerID):
		return fmt.Errorf("video_id/owner_id are not UUIDs")
	case ev.MediaPrefix != "v/"+ev.VideoID+"/":
		return fmt.Errorf("media_prefix does not match v/{video_id}/")
	case ev.RawKey != ev.OwnerID+"/"+ev.VideoID+"/source":
		return fmt.Errorf("raw_key does not match {owner_id}/{video_id}/source")
	case ev.MediaBucket != j.MediaBucket || ev.RawBucket != j.RawBucket:
		return fmt.Errorf("event names unexpected buckets")
	}
	return nil
}

// Purge deletes the media prefix and the raw object.
func (j *Janitor) Purge(ctx context.Context, ev deletedEvent) error {
	if err := j.Objects.DeletePrefix(ctx, j.MediaBucket, ev.MediaPrefix); err != nil {
		return err
	}
	return j.Objects.DeleteObject(ctx, j.RawBucket, ev.RawKey)
}

var scratchDirRe = regexp.MustCompile(`^[0-9a-f-]{36}-a\d+$`)

// CleanScratch removes leftovers of crashed jobs (`<video_id>-a<attempt>`
// directories) from the scratch directory. Call it at startup, before any job
// runs. Other entries are left alone.
func CleanScratch(dir string, log *slog.Logger) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() && scratchDirRe.MatchString(e.Name()) && !strings.HasPrefix(e.Name(), ".") {
			if err := os.RemoveAll(filepath.Join(dir, e.Name())); err != nil {
				log.Warn("clean scratch", "dir", e.Name(), "error", err)
			}
		}
	}
}
