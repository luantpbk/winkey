package integration

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/luantpbk/winkey/libs/go/s3x"
	"github.com/luantpbk/winkey/libs/go/testkit"
	"github.com/luantpbk/winkey/services/transcoder/internal/job"
	"github.com/luantpbk/winkey/services/transcoder/internal/media"
	"github.com/luantpbk/winkey/services/transcoder/internal/objects"
	"github.com/luantpbk/winkey/services/transcoder/internal/store"
	"github.com/luantpbk/winkey/services/transcoder/internal/testutil"
)

// Byte comparisons fix FFmpeg video/filter threads to one in BOTH runs: x264's
// multi-threaded ABR output is not deterministic. Production arguments are unchanged.
type deterministicMedia struct {
	job.Tools
	fail     string
	uploaded <-chan struct{}
}

func (d deterministicMedia) RunHLS(ctx context.Context, plan media.HLSPlan, _ float64, onProgress func(float64)) error {
	if d.fail == "always" || (d.fail == "nvenc" && plan.Encoder == media.EncoderNVENC) {
		dir := filepath.Join(plan.OutDir, plan.Renditions[0].Name)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
		// A higher segment number is never overwritten by the shorter successful retry.
		for _, name := range []string{"seg_00000.m4s", "seg_99999.m4s"} {
			if err := os.WriteFile(filepath.Join(dir, name), []byte("failed NVENC sentinel"), 0o600); err != nil {
				return err
			}
		}
		select {
		case <-d.uploaded:
		case <-ctx.Done():
			return ctx.Err()
		}
		return &job.EncoderError{Op: "injected mid-run encoder failure", Err: errors.New("GPU lost after uploaded segment")}
	}
	if err := deterministicEncode(ctx, d.Tools, plan, false); err != nil {
		return err
	}
	onProgress(100)
	return nil
}
func deterministicEncode(ctx context.Context, tools job.Tools, plan media.HLSPlan, oldFlags bool) error {
	for _, r := range plan.Renditions {
		if err := os.MkdirAll(filepath.Join(plan.OutDir, r.Name), 0o755); err != nil {
			return err
		}
	}
	args := media.BuildHLSArgs(plan)
	if oldFlags {
		for i, arg := range args {
			if arg == "independent_segments+temp_file" {
				args[i] = "independent_segments"
			}
		}
	}
	last := args[len(args)-1]
	args = append(args[:len(args)-1], "-threads:v", "1", "-filter_complex_threads", "1", last)
	cmd := exec.CommandContext(ctx, tools.FFmpeg, args...)
	cmd.Dir = plan.OutDir
	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("real deterministic FFmpeg: %w: %s", err, output)
	}
	return nil
}

type observedGarage struct {
	job.Objects
	uploaded chan struct{}
	once     sync.Once
}

func (o *observedGarage) UploadFile(ctx context.Context, bucket, key, src, ct, cc string) error {
	err := o.Objects.UploadFile(ctx, bucket, key, src, ct, cc)
	if err == nil && strings.HasSuffix(key, "seg_99999.m4s") {
		o.once.Do(func() { close(o.uploaded) })
	}
	return err
}

func preOverlapOutput(t *testing.T, tools job.Tools, clip string) string {
	t.Helper()
	ctx := context.Background()
	info, err := tools.Probe(ctx, clip)
	if err != nil {
		t.Fatal(err)
	}
	out := t.TempDir()
	hls := filepath.Join(out, "hls")
	rs := media.Select(info.DisplayW, info.DisplayH)
	plan := media.HLSPlan{Input: clip, OutDir: hls, Encoder: media.EncoderX264, X264Preset: "ultrafast", Renditions: rs, FPS: info.FPS, HasAudio: info.HasAudio}
	if err := deterministicEncode(ctx, tools, plan, true); err != nil {
		t.Fatal(err)
	}
	if err := media.VerifyOutput(hls, rs); err != nil {
		t.Fatal(err)
	}
	if err := tools.Thumbnail(ctx, clip, filepath.Join(out, "thumb", "poster.jpg"), info.DurationSec*0.1); err != nil {
		t.Fatal(err)
	}
	r, ok := media.StoryboardRendition(rs)
	if !ok {
		t.Fatal("fixture lacks storyboard rendition")
	}
	if _, err := tools.Storyboard(ctx, job.StoryboardInput{Path: filepath.Join(hls, r.Name, "index.m3u8"), KeyframesOnly: true}, filepath.Join(out, "storyboard"), info.DurationSec); err != nil {
		t.Fatal(err)
	}
	return out
}
func compareGarageOutput(t *testing.T, s *stack, prefix, expected string) {
	t.Helper()
	ctx := context.Background()
	want := map[string][]byte{}
	if err := filepath.WalkDir(expected, func(file string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, err := filepath.Rel(expected, file)
		if err != nil {
			return err
		}
		data, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		want[filepath.ToSlash(rel)] = data
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	pager := s3.NewListObjectsV2Paginator(s.g.S3Client(), &s3.ListObjectsV2Input{Bucket: aws.String(testkit.MediaBucket), Prefix: aws.String(prefix)})
	got := 0
	for pager.HasMorePages() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			t.Fatal(err)
		}
		for _, obj := range page.Contents {
			rel := strings.TrimPrefix(aws.ToString(obj.Key), prefix)
			data, ok := want[rel]
			if !ok {
				t.Fatalf("unexpected output %s", rel)
			}
			got++
			value, err := s.g.S3Client().GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(testkit.MediaBucket), Key: obj.Key})
			if err != nil {
				t.Fatal(err)
			}
			raw, readErr := io.ReadAll(value.Body)
			closeErr := value.Body.Close()
			if readErr != nil || closeErr != nil {
				t.Fatalf("read object: %v %v", readErr, closeErr)
			}
			if strings.HasPrefix(rel, "hls/") && !bytes.Equal(raw, data) {
				t.Errorf("HLS bytes changed at %s (%d vs %d)", rel, len(raw), len(data))
			}
			delete(want, rel)
		}
	}
	if len(want) != 0 {
		t.Errorf("missing output: %v", want)
	}
	t.Logf("%d object keys identical; all HLS segments/init/playlists byte-identical to pre-overlap x264", got)
}

func TestOverlapRealGarageObjectSetAndFailures(t *testing.T) {
	// Real PG/NATS/Garage, without a competing consumer: Process is invoked with a
	// controlled delivery so failures cannot redeliver during assertions.
	s := startStack(t, media.EncoderX264, false)
	s.tools = testutil.ToolsFromEnv(t)
	s.g = testkit.StartGarage(t)
	client, err := s3x.New(s3x.Config{Endpoint: s.g.Endpoint, Region: s.g.Region, AccessKeyID: s.g.AccessKey, SecretAccessKey: s.g.SecretKey})
	if err != nil {
		t.Fatal(err)
	}
	s.obj = objects.New(client)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	pipeline := func(tools job.MediaTools, objs job.Objects, encoder string) *job.Pipeline {
		return &job.Pipeline{Store: &store.Postgres{Pool: s.pg.Pool}, Objects: objs, Events: natsPub{s.nats}, Tools: tools, Log: s.log,
			Cfg: job.Config{ScratchDir: t.TempDir(), ArchiveDir: t.TempDir(), MediaBucket: testkit.MediaBucket, Encoder: encoder, X264Preset: "ultrafast", UploadParallelism: 2, WorkerID: "overlap-it"}}
	}
	for _, fixture := range []testutil.Clip{testutil.ClipLandscape, testutil.ClipPortrait, testutil.ClipSilent} {
		t.Run(fixture.Name, func(t *testing.T) {
			clip := testutil.MakeClip(t, s.tools, t.TempDir(), fixture)
			expected := preOverlapOutput(t, s.tools, clip)
			id, _ := s.seed(t, clip)
			res := pipeline(deterministicMedia{Tools: s.tools}, s.obj, media.EncoderX264).Process(ctx, job.UploadedEvent{VideoID: id.String()}, job.Delivery{Num: 1, Max: 3})
			if res.Action != job.ActionAck || res.Stats == nil {
				t.Fatalf("result %+v", res)
			}
			compareGarageOutput(t, s, "v/"+id.String()+"/a1/", expected)
			s.waitStatus(t, id, "READY", time.Second)
			if ready := s.events(t, "video.ready", id.String()); len(ready) != 1 {
				t.Fatalf("real NATS video.ready count %d", len(ready))
			}
		})
	}
	clip := testutil.MakeClip(t, s.tools, t.TempDir(), testutil.ClipSmall)
	expected := preOverlapOutput(t, s.tools, clip)
	for _, mode := range []string{"nvenc", "always"} {
		t.Run(mode, func(t *testing.T) {
			id, _ := s.seed(t, clip)
			spy := &observedGarage{Objects: s.obj, uploaded: make(chan struct{})}
			encoder := media.EncoderNVENC
			if mode == "always" {
				encoder = media.EncoderX264
			}
			res := pipeline(deterministicMedia{Tools: s.tools, fail: mode, uploaded: spy.uploaded}, spy, encoder).Process(ctx, job.UploadedEvent{VideoID: id.String()}, job.Delivery{Num: 1, Max: 1})
			select {
			case <-spy.uploaded:
			default:
				t.Fatal("failure was not after a real Garage PUT")
			}
			prefix := "v/" + id.String() + "/a1/"
			if mode == "nvenc" {
				if res.Action != job.ActionAck || res.Stats == nil || res.Stats.Encoder != media.EncoderX264 {
					t.Fatalf("fallback %+v", res)
				}
				var attempts int
				var storedEncoder string
				if err := s.pg.Pool.QueryRow(ctx, "SELECT count(*), min(encoder) FROM media.transcode_jobs WHERE video_id=$1", id).Scan(&attempts, &storedEncoder); err != nil {
					t.Fatal(err)
				}
				if attempts != 1 || storedEncoder != "x264" {
					t.Fatalf("fallback attempt count %d encoder %s", attempts, storedEncoder)
				}
				compareGarageOutput(t, s, prefix, expected)
			} else {
				if res.Action != job.ActionTermDLQ || res.Stats != nil {
					t.Fatalf("failed encoder %+v", res)
				}
				s.waitStatus(t, id, "FAILED", time.Second)
				var ready int
				if err := s.pg.Pool.QueryRow(ctx, "SELECT count(*) FROM media.outbox WHERE subject='video.ready' AND payload->'data'->>'video_id'=$1", id.String()).Scan(&ready); err != nil {
					t.Fatal(err)
				}
				if ready != 0 {
					t.Fatal("failed attempt emitted READY")
				}
				page, err := s.g.S3Client().ListObjectsV2(ctx, &s3.ListObjectsV2Input{Bucket: aws.String(testkit.MediaBucket), Prefix: aws.String(prefix)})
				if err != nil {
					t.Fatal(err)
				}
				if len(page.Contents) != 0 {
					t.Fatalf("failed output survived: %v", page.Contents)
				}
				t.Log("forced failure after real segment PUT: FAILED, no READY/outbox event, attempt prefix empty")
			}
		})
	}
}
