package views

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

// Key layout in Valkey (task C3).
const (
	keyPending  = "views:pending"    // hash: video_id -> counted views not yet in PostgreSQL
	flushPrefix = "views:flush:"     // views:flush:{uuid}: a pending hash taken by a flusher
	lockPrefix  = "views:flushlock:" // views:flushlock:{uuid}: who is applying that batch
	seenPrefix  = "views:seen:"      // views:seen:{video_id}:{viewer}
	pbPrefix    = "views:pb:"        // views:pb:{playback_id}
	ratePrefix  = "views:rl:"        // views:rl:{client_ip}
	breakerFor  = 5 * time.Second
	scanCount   = 100
	maxFlushIDs = 100_000 // guard: a flush batch larger than this is applied in one go anyway
)

// ErrUnavailable means Valkey could not be used (down, timing out, refusing).
// The API then answers 202 {counted:false} instead of failing.
var ErrUnavailable = errors.New("views: valkey unavailable")

// Valkey is the counter's view of the server: dedup, rate limit and the
// buffer that the flusher drains.
//
// Standalone Valkey is assumed: the count script touches three keys atomically,
// which a sharded cluster would not allow.
type Valkey struct {
	client *redis.Client

	// DedupTTL is how long a viewer (and a playback) counts once: 30 minutes in
	// production (contract), short in tests.
	DedupTTL time.Duration
	// BreakerFor is how long Allow/Count fail fast after an error, so an outage
	// costs one short timeout per interval instead of one per request.
	BreakerFor time.Duration

	downUntil atomic.Int64
}

// NewValkey wraps a client built with cache.NewClient (short timeouts, no retries).
func NewValkey(client *redis.Client, dedupTTL time.Duration) *Valkey {
	if dedupTTL <= 0 {
		dedupTTL = 30 * time.Minute
	}
	return &Valkey{client: client, DedupTTL: dedupTTL, BreakerFor: breakerFor}
}

func (v *Valkey) open() bool { return time.Now().UnixNano() < v.downUntil.Load() }

func (v *Valkey) trip(err error) error {
	v.downUntil.Store(time.Now().Add(v.BreakerFor).UnixNano())
	return fmt.Errorf("%w: %v", ErrUnavailable, err)
}

// Ping reports whether Valkey answers.
func (v *Valkey) Ping(ctx context.Context) error { return v.client.Ping(ctx).Err() }

// rateScript: fixed window per client IP. Returns {count, ttl_ms}.
var rateScript = redis.NewScript(`
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {n, ttl}
`)

// Allow counts one report for the client IP in the current window and reports
// whether it is within the limit. retryAfter is the time until the window ends.
func (v *Valkey) Allow(ctx context.Context, ip string, limit int, window time.Duration) (ok bool, retryAfter time.Duration, err error) {
	if v.open() {
		return false, 0, ErrUnavailable
	}
	res, err := rateScript.Run(ctx, v.client, []string{ratePrefix + ip}, window.Milliseconds()).Int64Slice()
	if err != nil || len(res) != 2 {
		return false, 0, v.trip(fmt.Errorf("rate limit: %v", err))
	}
	return res[0] <= int64(limit), time.Duration(res[1]) * time.Millisecond, nil
}

// countScript is the whole dedup-and-buffer step, atomic:
//
//	the playback counts once     SET views:pb:{playback_id}        NX PX ttl
//	the viewer counts once       SET views:seen:{video}:{viewer}   NX PX ttl
//	then                         HINCRBY views:pending {video} 1
//
// Doing it in one script means a crash or an outage cannot leave a playback
// marked as seen without its view buffered, or the reverse.
var countScript = redis.NewScript(`
if not redis.call('SET', KEYS[1], '1', 'NX', 'PX', ARGV[1]) then return 0 end
if not redis.call('SET', KEYS[2], '1', 'NX', 'PX', ARGV[1]) then return 0 end
redis.call('HINCRBY', KEYS[3], ARGV[2], 1)
return 1
`)

// Count adds one view unless this viewer or this playback was already counted
// within DedupTTL. It returns true when a view was added.
func (v *Valkey) Count(ctx context.Context, videoID, playbackID uuid.UUID, viewer string) (bool, error) {
	if v.open() {
		return false, ErrUnavailable
	}
	n, err := countScript.Run(ctx, v.client,
		[]string{pbPrefix + playbackID.String(), seenPrefix + videoID.String() + ":" + viewer, keyPending},
		v.DedupTTL.Milliseconds(), videoID.String()).Int()
	if err != nil {
		return false, v.trip(fmt.Errorf("count: %v", err))
	}
	return n == 1, nil
}

// ---- flusher side --------------------------------------------------------------

// Rotate atomically moves the pending hash to a fresh flush key and returns
// its name; ok is false when there was nothing pending. RENAME is atomic, so
// concurrent flushers each get a distinct batch and reports arriving during the
// rename start a new pending hash.
func (v *Valkey) Rotate(ctx context.Context) (key string, ok bool, err error) {
	key = flushPrefix + uuid.NewString()
	if err := v.client.Rename(ctx, keyPending, key).Err(); err != nil {
		if strings.Contains(err.Error(), "no such key") {
			return "", false, nil
		}
		return "", false, err
	}
	return key, true, nil
}

// FlushKeys lists every views:flush:* key: batches taken by a flusher that has
// not finished with them (a failed database write, or a crash).
func (v *Valkey) FlushKeys(ctx context.Context) ([]string, error) {
	var keys []string
	iter := v.client.Scan(ctx, 0, flushPrefix+"*", scanCount).Iterator()
	for iter.Next(ctx) {
		keys = append(keys, iter.Val())
	}
	return keys, iter.Err()
}

// Lock claims a flush key for this process for ttl. Every path that applies a
// batch (a fresh rotation, a retry, a leftover from a crashed replica) takes
// this lock first, so a batch is never applied by two replicas at once. The TTL
// frees it if the holder dies.
func (v *Valkey) Lock(ctx context.Context, flushKey string, ttl time.Duration) (bool, error) {
	return v.client.SetNX(ctx, lockPrefix+strings.TrimPrefix(flushKey, flushPrefix), "1", ttl).Result()
}

// Unlock releases the claim (the batch stays for the next attempt).
func (v *Valkey) Unlock(ctx context.Context, flushKey string) error {
	return v.client.Del(ctx, lockPrefix+strings.TrimPrefix(flushKey, flushPrefix)).Err()
}

// Batch reads a flush key: video id -> counted views. Entries that are not a
// valid "uuid -> positive integer" pair are returned in bad and never applied.
func (v *Valkey) Batch(ctx context.Context, flushKey string) (counts map[uuid.UUID]int64, bad []string, err error) {
	raw, err := v.client.HGetAll(ctx, flushKey).Result()
	if err != nil {
		return nil, nil, err
	}
	counts = make(map[uuid.UUID]int64, len(raw))
	for f, s := range raw {
		id, perr := uuid.Parse(f)
		var n int64
		if _, serr := fmt.Sscanf(s, "%d", &n); perr != nil || serr != nil || n <= 0 {
			bad = append(bad, f)
			continue
		}
		counts[id] = n
	}
	return counts, bad, nil
}

// Done removes an applied batch and its lock.
func (v *Valkey) Done(ctx context.Context, flushKey string) error {
	return v.client.Del(ctx, flushKey, lockPrefix+strings.TrimPrefix(flushKey, flushPrefix)).Err()
}
