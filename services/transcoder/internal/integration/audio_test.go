package integration

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/libs/go/outbox"
	"github.com/luantpbk/winkey/libs/go/testkit"
	"github.com/luantpbk/winkey/services/transcoder/internal/audio"
	"github.com/luantpbk/winkey/services/transcoder/internal/media"
	"github.com/luantpbk/winkey/services/transcoder/internal/store"
	"github.com/luantpbk/winkey/services/transcoder/internal/testutil"
)

// TestAudioTrackEndToEnd (MUX1): a READY video gets an extra audio track through the audio consumer: the
// track is encoded into Garage, the master gets the audio group under a new key, and ffprobe can read
// the alternate rendition the master points at.
func TestAudioTrackEndToEnd(t *testing.T) {
	s := start(t, media.EncoderX264)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	ac := &audio.Consumer{JS: s.nats.JS, Log: s.log, Job: &audio.Job{
		Store: &store.Postgres{Pool: s.pg.Pool}, Objects: s.obj, Media: s.tools,
		MediaBucket: testkit.MediaBucket, WorkDir: t.TempDir(), Log: s.log,
	}}
	go func() { _ = ac.Run(ctx) }()

	vid, owner := s.seed(t, testutil.MakeClip(t, s.tools, t.TempDir(), testutil.ClipSmall))
	s.waitStatus(t, vid, "READY", 3*time.Minute)
	var plainMaster string
	var durMs int
	if err := s.pg.Pool.QueryRow(ctx, `SELECT hls_master_key, duration_ms FROM media.videos WHERE id = $1`, vid).Scan(&plainMaster, &durMs); err != nil {
		t.Fatal(err)
	}

	// The track, as upload-svc leaves it: the raw object, the UPLOADED row and video.audio_uploaded.
	dir := t.TempDir()
	flac := filepath.Join(dir, "vi.flac")
	secs := fmt.Sprintf("%.3f", float64(durMs)/1000)
	if b, err := exec.Command(s.tools.FFmpeg, "-hide_banner", "-loglevel", "error", "-f", "lavfi",
		"-i", "sine=frequency=330:sample_rate=48000:duration="+secs, "-ac", "2", "-c:a", "flac", flac).CombinedOutput(); err != nil {
		t.Fatalf("make audio: %v %s", err, b)
	}
	f, err := os.Open(flac)
	if err != nil {
		t.Fatal(err)
	}
	st, _ := f.Stat()
	tid := ids.New()
	rawKey := owner.String() + "/" + vid.String() + "/audio/" + tid.String() + "/source"
	if _, err := s.g.S3Client().PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(testkit.RawBucket), Key: &rawKey, Body: f, ContentLength: aws.Int64(st.Size()),
	}); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()
	tx, err := s.pg.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO media.video_audio_tracks (id, video_id, lang, label, kind, status, raw_bucket, raw_key, content_type, size_bytes)
		VALUES ($1, $2, 'vi', 'Thuyết minh', 'voiceover', 'UPLOADED', $3, $4, 'audio/flac', $5)`,
		tid, vid, testkit.RawBucket, rawKey, st.Size()); err != nil {
		t.Fatal(err)
	}
	if err := outbox.Enqueue(ctx, tx, "media", "video.audio_uploaded", audio.UploadedEvent{
		VideoID: vid.String(), OwnerID: owner.String(), TrackID: tid.String(), Lang: "vi", Kind: "voiceover",
		RawBucket: testkit.RawBucket, RawKey: rawKey, SizeBytes: st.Size(), ContentType: "audio/flac",
	}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	// READY within a minute.
	var status, errCode string
	deadline := time.Now().Add(time.Minute)
	for time.Now().Before(deadline) {
		_ = s.pg.Pool.QueryRow(ctx, `SELECT status, coalesce(error, '') FROM media.video_audio_tracks WHERE id = $1`, tid).Scan(&status, &errCode)
		if status == "READY" || status == "FAILED" {
			break
		}
		time.Sleep(300 * time.Millisecond)
	}
	if status != "READY" {
		t.Fatalf("track %s %s", status, errCode)
	}

	var master string
	_ = s.pg.Pool.QueryRow(ctx, `SELECT hls_master_key FROM media.videos WHERE id = $1`, vid).Scan(&master)
	if master == plainMaster || !strings.HasPrefix(master, "v/"+vid.String()+"/a1/hls/master-") {
		t.Fatalf("master key %s (was %s)", master, plainMaster)
	}
	cl := s.g.S3Client()
	get := func(key string) []byte {
		t.Helper()
		obj, err := cl.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(testkit.MediaBucket), Key: &key})
		if err != nil {
			t.Fatalf("get %s: %v", key, err)
		}
		b, _ := io.ReadAll(obj.Body)
		return b
	}
	body := string(get(master))
	uri := "../../audio/" + tid.String() + "/index.m3u8"
	if !strings.Contains(body, `URI="`+uri+`"`) || !strings.Contains(body, `AUDIO="aud"`) {
		t.Fatalf("master:\n%s", body)
	}

	// The rendition the master points at plays: download it with its layout and let ffprobe read it.
	local := filepath.Join(dir, "media")
	audioDir := "v/" + vid.String() + "/audio/" + tid.String() + "/"
	playlist := get(audioDir + "index.m3u8")
	files := []string{"index.m3u8", "init.mp4"}
	for _, l := range strings.Split(string(playlist), "\n") {
		if l = strings.TrimSpace(l); l != "" && !strings.HasPrefix(l, "#") {
			files = append(files, l)
		}
	}
	if len(files) < 4 {
		t.Fatalf("playlist lists too few segments:\n%s", playlist)
	}
	for _, name := range files {
		p := filepath.Join(local, filepath.FromSlash(audioDir+name))
		if err := os.MkdirAll(filepath.Dir(p), 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, get(audioDir+name), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	info, err := s.tools.ProbeAudio(ctx, filepath.Join(local, filepath.FromSlash(audioDir+"index.m3u8")))
	if err != nil || info.Codec != "aac" || info.Channels != 2 || info.SampleRate != 48000 || !media.AudioMatchesVideo(info.DurationSec, durMs) {
		t.Fatalf("probe of the rendition: %+v %v", info, err)
	}

	ready := s.events(t, "video.audio_ready", vid.String())
	if len(ready) != 1 || ready[0].Producer != "transcoder" || !strings.Contains(string(ready[0].Data), master) {
		t.Fatalf("video.audio_ready: %+v", ready)
	}
}
