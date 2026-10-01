package integration

import (
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"path"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/libs/go/testkit"
	"github.com/luantpbk/winkey/services/transcoder/internal/backfill"
	"github.com/luantpbk/winkey/services/transcoder/internal/job"
	"github.com/luantpbk/winkey/services/transcoder/internal/store"
	"github.com/luantpbk/winkey/services/transcoder/internal/testutil"
)

// backfillTools finds ffmpeg like testutil.ToolsFromEnv, but with WINKEY_REQUIRE_DOCKER=1 (CI) a missing
// ffmpeg fails the test instead of skipping it: the backfill test must never be silently skipped there.
func backfillTools(t *testing.T) job.Tools {
	t.Helper()
	find := func(env, name string) string {
		if p := os.Getenv(env); p != "" {
			return p
		}
		p, err := exec.LookPath(name)
		if err != nil {
			if os.Getenv("WINKEY_REQUIRE_DOCKER") == "1" {
				t.Fatalf("%s not found (set %s) and WINKEY_REQUIRE_DOCKER=1: %v", name, env, err)
			}
			t.Skipf("%s not found (set %s): %v", name, env, err)
		}
		return p
	}
	return job.Tools{FFmpeg: find("FFMPEG_PATH", "ffmpeg"), FFprobe: find("FFPROBE_PATH", "ffprobe")}
}

type videoRow struct {
	status     string
	storyboard *string
}

func (s *stack) row(t *testing.T, id uuid.UUID) videoRow {
	t.Helper()
	var r videoRow
	if err := s.pg.Pool.QueryRow(context.Background(),
		`SELECT status::text, storyboard_key FROM media.videos WHERE id = $1`, id).Scan(&r.status, &r.storyboard); err != nil {
		t.Fatal(err)
	}
	return r
}

// TestStoryboardBackfill: 3 READY videos without a storyboard (real HLS renditions made by the worker),
// 1 READY video that has one, 1 PROCESSING video. One run storyboards exactly the 3; a second run selects 0.
func TestStoryboardBackfill(t *testing.T) {
	_ = backfillTools(t) // fails (does not skip) without ffmpeg when WINKEY_REQUIRE_DOCKER=1
	s := start(t, "x264")
	ctx := context.Background()
	clip := testutil.MakeClip(t, s.tools, t.TempDir(), testutil.ClipSmall)

	// Four videos go through the real worker, which makes their storyboard.
	var vids []uuid.UUID
	for range 4 {
		id, _ := s.seed(t, clip)
		vids = append(vids, id)
	}
	for _, id := range vids {
		s.waitStatus(t, id, "READY", 3*time.Minute)
	}
	withSB := vids[3]
	without := vids[:3]
	keepKey := *s.row(t, withSB).storyboard

	// Make three of them look like videos from before V5a: no storyboard_key, no storyboard objects.
	for i, id := range without {
		if _, err := s.pg.Pool.Exec(ctx, `UPDATE media.videos SET storyboard_key = NULL, created_at = now() - make_interval(mins => $2) WHERE id = $1`, id, i+1); err != nil {
			t.Fatal(err)
		}
		if err := s.obj.DeletePrefix(ctx, testkit.MediaBucket, "v/"+id.String()+"/a1/storyboard/"); err != nil {
			t.Fatal(err)
		}
	}
	processing := ids.New()
	if _, err := s.pg.Pool.Exec(ctx, `
		INSERT INTO media.videos (id, owner_id, title, status, raw_bucket, raw_key, content_type, size_bytes)
		VALUES ($1, $2, 'p', 'UPLOADING', $3, 'k', 'video/mp4', 10)`, processing, ids.New(), testkit.RawBucket); err != nil {
		t.Fatal(err)
	}
	for _, st := range []string{"UPLOADED", "PROCESSING"} {
		if _, err := s.pg.Pool.Exec(ctx, `UPDATE media.videos SET status = $2::media.video_status WHERE id = $1`, processing, st); err != nil {
			t.Fatal(err)
		}
	}

	runner := func(dry bool) *backfill.Runner {
		return &backfill.Runner{
			Store: &store.Postgres{Pool: s.pg.Pool}, Objects: s.obj, Storyboard: s.tools.Storyboard, Log: s.log,
			Opt: backfill.Options{Limit: 100, Concurrency: 2, DryRun: dry, MediaBucket: testkit.MediaBucket, ScratchDir: t.TempDir()},
		}
	}

	// A dry run lists the three and writes nothing.
	sum, err := runner(true).Run(ctx)
	if err != nil || sum.Selected != 3 || sum.WouldDo != 3 || sum.Done != 0 {
		t.Fatalf("dry run: %+v %v", sum, err)
	}
	for _, id := range without {
		if r := s.row(t, id); r.storyboard != nil {
			t.Fatalf("dry run set storyboard_key of %s", id)
		}
	}

	scratch := t.TempDir()
	r := runner(false)
	r.Opt.ScratchDir = scratch
	sum, err = r.Run(ctx)
	if err != nil || sum.Selected != 3 || sum.Done != 3 || sum.Failed != 0 || sum.SkippedNoRendition != 0 || sum.LostRace != 0 {
		t.Fatalf("run: %+v %v", sum, err)
	}
	if left, _ := os.ReadDir(scratch); len(left) != 0 {
		t.Errorf("scratch dir not empty after the run: %d entries", len(left))
	}

	cl := s.g.S3Client()
	get := func(key string) (*s3.GetObjectOutput, []byte) {
		t.Helper()
		o, err := cl.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(testkit.MediaBucket), Key: aws.String(key)})
		if err != nil {
			t.Fatalf("get %s: %v", key, err)
		}
		b, _ := io.ReadAll(o.Body)
		return o, b
	}
	for _, id := range without {
		row := s.row(t, id)
		prefix := "v/" + id.String() + "/a1/"
		if row.status != "READY" || row.storyboard == nil || *row.storyboard != prefix+"storyboard/storyboard.vtt" {
			t.Fatalf("video %s: %+v", id, row)
		}
		o, vtt := get(*row.storyboard)
		if aws.ToString(o.ContentType) != "text/vtt" || aws.ToString(o.CacheControl) != "public, max-age=31536000, immutable" ||
			!bytes.HasPrefix(vtt, []byte("WEBVTT\n\n00:00:00.000 --> ")) {
			t.Errorf("vtt of %s: %q %q %.60q", id, aws.ToString(o.ContentType), aws.ToString(o.CacheControl), vtt)
		}
		// Every sheet the track refers to exists, as an image.
		sheets := map[string]bool{}
		for _, line := range strings.Split(string(vtt), "\n") {
			if name, _, ok := strings.Cut(line, "#xywh="); ok {
				sheets[name] = true
			}
		}
		if len(sheets) == 0 {
			t.Fatalf("vtt of %s refers to no sheet:\n%s", id, vtt)
		}
		for name := range sheets {
			so, body := get(path.Join(path.Dir(*row.storyboard), name))
			if aws.ToString(so.ContentType) != "image/jpeg" || len(body) < 1000 || body[0] != 0xFF || body[1] != 0xD8 {
				t.Errorf("sheet %s of %s: %q, %d bytes", name, id, aws.ToString(so.ContentType), len(body))
			}
		}
	}

	// The READY video that had a storyboard and the PROCESSING one are untouched.
	if r := s.row(t, withSB); r.status != "READY" || r.storyboard == nil || *r.storyboard != keepKey {
		t.Errorf("video with storyboard changed: %+v (was %s)", r, keepKey)
	}
	if r := s.row(t, processing); r.status != "PROCESSING" || r.storyboard != nil {
		t.Errorf("processing video changed: %+v", r)
	}

	// A second run has nothing left to select.
	sum, err = runner(false).Run(ctx)
	if err != nil || sum.Selected != 0 || sum.Done != 0 {
		t.Fatalf("second run: %+v %v", sum, err)
	}
}
