package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/httpx"
	"github.com/luantpbk/winkey/libs/go/s3x"
	"github.com/luantpbk/winkey/libs/go/testkit"
	"github.com/luantpbk/winkey/services/video/internal/api"
	"github.com/luantpbk/winkey/services/video/internal/contract"
	"github.com/luantpbk/winkey/services/video/internal/domain"
	"github.com/luantpbk/winkey/services/video/internal/objects"
	"github.com/luantpbk/winkey/services/video/internal/store"
	"github.com/luantpbk/winkey/services/video/internal/testutil"
)

// Task V5b on real PostgreSQL 17 and a real object store: Garage (testkit) whenever Docker is available, as in
// CI with WINKEY_REQUIRE_DOCKER=1. WINKEY_TEST_INMEMORY_S3=1 swaps Garage for an in-memory store, for a machine
// without Docker (then the object-store side is a fake, and the PR says so). Every response is validated
// against video.v1.yaml.

// mediaBucket is the bucket the handler writes to (testkit.MediaBucket is the one Garage creates).
const mediaBucketName = "winkey-media"

// bucketObjects is domain.Objects plus what the tests need to look inside the bucket.
type bucketObjects interface {
	domain.Objects
	Get(key string) (contentType, cacheControl string, body []byte, ok bool)
	Keys(prefix string) []string
	// DeletePrefix is what the media janitor does with the media_prefix of video.deleted.
	DeletePrefix(prefix string) error
	Backend() string
}

func startObjects(t *testing.T) bucketObjects {
	t.Helper()
	if os.Getenv("WINKEY_TEST_INMEMORY_S3") != "" {
		return &memBucket{m: testutil.NewMemObjects()}
	}
	g := testkit.StartGarage(t)
	c, err := s3x.New(s3x.Config{Endpoint: g.Endpoint, Region: g.Region, AccessKeyID: g.AccessKey, SecretAccessKey: g.SecretKey})
	if err != nil {
		t.Fatal(err)
	}
	return &garageBucket{S3: objects.New(c), c: c, sdk: g.S3Client()}
}

type memBucket struct{ m *testutil.MemObjects }

func (b *memBucket) Put(ctx context.Context, bucket, key string, data []byte, ct, cc string) error {
	return b.m.Put(ctx, bucket, key, data, ct, cc)
}
func (b *memBucket) Delete(ctx context.Context, bucket, key string) error {
	return b.m.Delete(ctx, bucket, key)
}
func (b *memBucket) Get(key string) (string, string, []byte, bool) {
	o, ok := b.m.Get(mediaBucketName, key)
	return o.ContentType, o.CacheControl, o.Data, ok
}
func (b *memBucket) Keys(prefix string) []string { return b.m.Keys(mediaBucketName, prefix) }
func (b *memBucket) DeletePrefix(prefix string) error {
	return b.m.DeletePrefix(mediaBucketName, prefix)
}
func (b *memBucket) Backend() string { return "in-memory" }

type garageBucket struct {
	*objects.S3
	c   *s3x.Client
	sdk *s3.Client
}

func (b *garageBucket) Get(key string) (string, string, []byte, bool) {
	out, err := b.sdk.GetObject(context.Background(), &s3.GetObjectInput{Bucket: aws.String(mediaBucketName), Key: &key})
	if err != nil {
		return "", "", nil, false
	}
	defer out.Body.Close()
	body, _ := io.ReadAll(out.Body)
	return aws.ToString(out.ContentType), aws.ToString(out.CacheControl), body, true
}

func (b *garageBucket) Keys(prefix string) []string {
	var keys []string
	p := s3.NewListObjectsV2Paginator(b.sdk, &s3.ListObjectsV2Input{Bucket: aws.String(mediaBucketName), Prefix: &prefix})
	for p.HasMorePages() {
		page, err := p.NextPage(context.Background())
		if err != nil {
			return keys
		}
		for _, o := range page.Contents {
			keys = append(keys, aws.ToString(o.Key))
		}
	}
	return keys
}

func (b *garageBucket) DeletePrefix(prefix string) error {
	return b.c.DeletePrefix(context.Background(), mediaBucketName, prefix)
}
func (b *garageBucket) Backend() string { return "Garage" }

type subStack struct {
	t    *testing.T
	pg   *testkit.Postgres
	obj  bucketObjects
	h    http.Handler
	spec *contract.Spec
	logs *strings.Builder
	now  time.Time
}

func startSubtitles(t *testing.T) *subStack {
	t.Helper()
	pg := testkit.StartPostgres(t)
	obj := startObjects(t)
	logs := &strings.Builder{}
	log := slog.New(slog.NewJSONHandler(&syncWriter{w: logs}, &slog.HandlerOptions{Level: slog.LevelWarn}))
	now := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	h := &api.Handler{Store: &store.Postgres{Pool: pg.Pool}, Objects: obj, MediaBaseURL: mediaBase, MediaBucket: mediaBucketName,
		CursorSecret: []byte("integration-cursor-secret"), Log: log,
		MediaLinkSecret: []byte(linkSecret), Now: func() time.Time { return now }}
	r := httpx.NewRouter("video-subtitles-it", log)
	h.Routes(r)
	return &subStack{t: t, pg: pg, obj: obj, h: r, spec: contract.Load(t), logs: logs, now: now}
}

type syncWriter struct {
	mu sync.Mutex
	w  io.Writer
}

func (s *syncWriter) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.w.Write(p)
}

var subtitlePathRe = regexp.MustCompile(`^/v1/videos/[^/]+/subtitles/[^/]+$`)

// do sends a request and validates the response against the contract (500 is not documented: use raw for it).
func (s *subStack) do(a *actor, method, path, body string) (int, http.Header, []byte) {
	s.t.Helper()
	code, hdr, b := s.raw(a, method, path, body)
	p, _, _ := strings.Cut(path, "?")
	switch {
	case subtitlePathRe.MatchString(p):
		p = "/v1/videos/{video_id}/subtitles/{lang}"
	case strings.HasPrefix(p, "/v1/videos/"):
		p = "/v1/videos/{video_id}"
	}
	s.spec.Check(s.t, method, p, code, hdr.Get("Content-Type"), b)
	return code, hdr, b
}

func (s *subStack) raw(a *actor, method, path, body string) (int, http.Header, []byte) {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if a != nil {
		req.Header.Set("X-User-Id", a.id.String())
		req.Header.Set("X-User-Roles", a.roles)
	}
	w := httptest.NewRecorder()
	s.h.ServeHTTP(w, req)
	return w.Code, w.Header(), w.Body.Bytes()
}

func (s *subStack) put(a *actor, v uuid.UUID, lang, label, content string) (int, []byte) {
	s.t.Helper()
	b, _ := json.Marshal(map[string]string{"label": label, "content": content})
	code, _, body := s.do(a, "PUT", fmt.Sprintf("/v1/videos/%s/subtitles/%s", v, lang), string(b))
	return code, body
}

func (s *subStack) rows(v uuid.UUID) map[string]string { // lang -> object_key
	s.t.Helper()
	rs, err := s.pg.Pool.Query(context.Background(), `SELECT lang, object_key FROM media.video_subtitles WHERE video_id = $1`, v)
	if err != nil {
		s.t.Fatal(err)
	}
	defer rs.Close()
	out := map[string]string{}
	for rs.Next() {
		var l, k string
		if err := rs.Scan(&l, &k); err != nil {
			s.t.Fatal(err)
		}
		out[l] = k
	}
	return out
}

func (s *subStack) keys(v uuid.UUID) []string { return s.obj.Keys("v/" + v.String() + "/subtitles/") }

type track struct {
	Lang      string `json:"lang"`
	Label     string `json:"label"`
	Source    string `json:"source"`
	URL       string `json:"url"`
	UpdatedAt string `json:"updated_at"`
}

const vttOK = "WEBVTT\n\n00:00.000 --> 00:01.000\nXin chào Hà Nội\n"

func TestSubtitlesCreateReplaceDeleteOnPostgresAndObjectStore(t *testing.T) {
	s := startSubtitles(t)
	t.Logf("object store: %s", s.obj.Backend())
	owner := testutil.SeedUser(t, s.pg.Pool, "alice", nil, "")
	alice := &actor{owner.ID, "viewer,creator"}
	video := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: owner.ID}).ID

	// 201: row, object under the new key, headers, normalised body.
	code, body := s.put(alice, video, "vi", " Tiếng Việt ", "\xef\xbb\xbfWEBVTT\r\n\r\n00:00.000 --> 00:01.000\r\nXin chào Hà Nội")
	if code != http.StatusCreated {
		t.Fatalf("create: %d %s", code, body)
	}
	created := js[track](t, body)
	rows := s.rows(video)
	key := rows["vi"]
	if len(rows) != 1 || !regexp.MustCompile(`^v/`+video.String()+`/subtitles/vi-[0-9a-f-]{36}\.vtt$`).MatchString(key) ||
		created.URL != mediaBase+"/"+key || created.Label != "Tiếng Việt" || created.Source != "UPLOAD" {
		t.Fatalf("row %v track %+v", rows, created)
	}
	ct, cc, data, ok := s.obj.Get(key)
	if !ok || ct != "text/vtt; charset=utf-8" || cc != "public, max-age=31536000, immutable" || string(data) != vttOK {
		t.Fatalf("object: ok=%v %q %q %q", ok, ct, cc, data)
	}
	var size int
	_ = s.pg.Pool.QueryRow(context.Background(), `SELECT size_bytes FROM media.video_subtitles WHERE video_id=$1 AND lang='vi'`, video).Scan(&size)
	if size != len(vttOK) {
		t.Fatalf("size_bytes %d, want %d", size, len(vttOK))
	}

	// 200: replace. New key, the old object is gone, the row follows, updated_at moves.
	code, body = s.put(alice, video, "vi", "Vietnamese", "WEBVTT\n\n00:00.000 --> 00:02.000\nMới\n")
	if code != http.StatusOK {
		t.Fatalf("replace: %d %s", code, body)
	}
	replaced := js[track](t, body)
	rows = s.rows(video)
	if rows["vi"] == key || len(rows) != 1 || replaced.Label != "Vietnamese" || replaced.URL == created.URL || replaced.UpdatedAt <= created.UpdatedAt {
		t.Fatalf("after replace: %v %+v (created %+v)", rows, replaced, created)
	}
	if _, _, _, still := s.obj.Get(key); still {
		t.Fatal("the replaced object is still in the bucket")
	}
	if got := s.keys(video); len(got) != 1 || got[0] != rows["vi"] {
		t.Fatalf("bucket: %v", got)
	}

	// Delete: 204, then 404; the row and the object are gone.
	if code, _, _ := s.do(alice, "DELETE", fmt.Sprintf("/v1/videos/%s/subtitles/vi", video), ""); code != http.StatusNoContent {
		t.Fatalf("delete: %d", code)
	}
	if code, _, _ := s.do(alice, "DELETE", fmt.Sprintf("/v1/videos/%s/subtitles/vi", video), ""); code != http.StatusNotFound {
		t.Fatalf("second delete: %d", code)
	}
	if len(s.rows(video)) != 0 || len(s.keys(video)) != 0 {
		t.Fatalf("left: rows %v keys %v", s.rows(video), s.keys(video))
	}
	if strings.Contains(s.logs.String(), "failed") {
		t.Fatalf("unexpected warnings:\n%s", s.logs)
	}
}

func TestSubtitlesAuthorisationOnPostgres(t *testing.T) {
	s := startSubtitles(t)
	owner := testutil.SeedUser(t, s.pg.Pool, "alice", nil, "")
	alice := &actor{owner.ID, "viewer,creator"}
	bob := &actor{testutil.SeedUser(t, s.pg.Pool, "bobby", nil, "").ID, "viewer,creator"}
	mod := &actor{testutil.SeedUser(t, s.pg.Pool, "moddy", nil, "").ID, "viewer,moderator"}
	admin := &actor{testutil.SeedUser(t, s.pg.Pool, "root", nil, "").ID, "admin"}
	video := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: owner.ID}).ID
	private := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: owner.ID, Visibility: "PRIVATE"}).ID
	failed := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: owner.ID, Status: "FAILED", Error: "boom"}).ID
	processing := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: owner.ID, Status: "PROCESSING", Attempts: []float32{10}}).ID

	for _, c := range []struct {
		name string
		who  *actor
		v    uuid.UUID
		want int
	}{
		{"other user", bob, video, 403}, {"moderator", mod, video, 403}, {"admin", admin, video, 403},
		{"anonymous", nil, video, 401}, {"invisible video", bob, private, 404}, {"unknown video", alice, uuid.New(), 404},
		{"FAILED video", alice, failed, 409},
	} {
		if code, body := s.put(c.who, c.v, "vi", "Tiếng Việt", vttOK); code != c.want {
			t.Errorf("%s: %d %s", c.name, code, body)
		}
		// Delete follows the same rules (a missing track is 404 for the owner).
		want := c.want
		if c.name == "FAILED video" {
			want = 404
		}
		if code, _, b := s.do(c.who, "DELETE", fmt.Sprintf("/v1/videos/%s/subtitles/vi", c.v), ""); code != want {
			t.Errorf("%s: delete %d %s", c.name, code, b)
		}
	}
	if n := len(s.obj.Keys("v/")); n != 0 {
		t.Fatalf("a refused request left %d objects", n)
	}
	// The owner can prepare a track while the video is still processing, and on a PRIVATE one.
	for _, v := range []uuid.UUID{processing, private} {
		if code, body := s.put(alice, v, "en", "English", vttOK); code != http.StatusCreated {
			t.Errorf("owner: %d %s", code, body)
		}
	}
}

// 25 concurrent uploads of 25 languages: the lock on the video row lets exactly 20 in, the 5 others get 409, and
// the objects uploaded for them are removed again.
func TestTwentyTrackLimitHoldsUnderConcurrency(t *testing.T) {
	s := startSubtitles(t)
	owner := testutil.SeedUser(t, s.pg.Pool, "alice", nil, "")
	alice := &actor{owner.ID, "viewer,creator"}
	video := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: owner.ID}).ID

	var mu sync.Mutex
	codes := map[int]int{}
	var wg sync.WaitGroup
	for i := 0; i < 25; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			code, _ := s.put(alice, video, fmt.Sprintf("a%c", 'a'+i), "label", vttOK)
			mu.Lock()
			codes[code]++
			mu.Unlock()
		}()
	}
	wg.Wait()
	if codes[201] != 20 || codes[409] != 5 || len(codes) != 2 {
		t.Fatalf("status codes %v", codes)
	}
	if n := len(s.rows(video)); n != 20 {
		t.Fatalf("%d rows", n)
	}
	if keys := s.keys(video); len(keys) != 20 {
		t.Fatalf("%d objects for 20 rows (leaked objects of refused uploads?)", len(keys))
	}
	// Replacing a language at the limit is fine; a 21st language is not. Which 20 of the 25 got in is up to
	// the scheduler, so the language to replace is one that really has a row.
	var existing string
	for lang := range s.rows(video) {
		existing = lang
		break
	}
	if code, _ := s.put(alice, video, existing, "again", vttOK); code != http.StatusOK {
		t.Fatalf("replace %q at the limit: %d", existing, code)
	}
	if code, _ := s.put(alice, video, "vi", "Tiếng Việt", vttOK); code != http.StatusConflict {
		t.Fatalf("21st language: %d", code)
	}
}

// Concurrent replacements of ONE language: each commits, exactly one object survives (the last one's).
func TestConcurrentReplacementsLeaveOneObject(t *testing.T) {
	s := startSubtitles(t)
	owner := testutil.SeedUser(t, s.pg.Pool, "alice", nil, "")
	alice := &actor{owner.ID, "viewer,creator"}
	video := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: owner.ID}).ID
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if code, body := s.put(alice, video, "vi", fmt.Sprintf("v%d", i), vttOK); code != 200 && code != 201 {
				t.Errorf("%d %s", code, body)
			}
		}()
	}
	wg.Wait()
	rows, keys := s.rows(video), s.keys(video)
	if len(rows) != 1 || len(keys) != 1 || keys[0] != rows["vi"] {
		t.Fatalf("rows %v keys %v", rows, keys)
	}
}

// A failure of the transaction after the upload leaves no orphan object and no row.
func TestFailedTransactionRemovesTheUploadedObject(t *testing.T) {
	s := startSubtitles(t)
	ctx := context.Background()
	owner := testutil.SeedUser(t, s.pg.Pool, "alice", nil, "")
	alice := &actor{owner.ID, "viewer,creator"}
	video := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: owner.ID}).ID
	for _, q := range []string{
		`CREATE FUNCTION media.refuse_subtitles() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'subtitles refused'; END $$`,
		`CREATE TRIGGER refuse_subtitles BEFORE INSERT ON media.video_subtitles FOR EACH ROW EXECUTE FUNCTION media.refuse_subtitles()`,
	} {
		if _, err := s.pg.Pool.Exec(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	b, _ := json.Marshal(map[string]string{"label": "x", "content": vttOK})
	code, _, body := s.raw(alice, "PUT", fmt.Sprintf("/v1/videos/%s/subtitles/vi", video), string(b)) // 500: not in the contract
	if code != http.StatusInternalServerError {
		t.Fatalf("%d %s", code, body)
	}
	if len(s.rows(video)) != 0 || len(s.keys(video)) != 0 {
		t.Fatalf("orphans: rows %v objects %v", s.rows(video), s.keys(video))
	}
	if _, err := s.pg.Pool.Exec(ctx, `DROP TRIGGER refuse_subtitles ON media.video_subtitles`); err != nil {
		t.Fatal(err)
	}
	if code, body := s.put(alice, video, "vi", "x", vttOK); code != http.StatusCreated {
		t.Fatalf("after the fault is gone: %d %s", code, body)
	}
}

func TestInvalidWebVTTOnPostgres(t *testing.T) {
	s := startSubtitles(t)
	owner := testutil.SeedUser(t, s.pg.Pool, "alice", nil, "")
	alice := &actor{owner.ID, "viewer,creator"}
	video := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: owner.ID}).ID
	for name, c := range map[string]struct{ content, code, detail string }{
		"no header":        {"00:00.000 --> 00:01.000\nx\n", "INVALID_WEBVTT", "line 1:"},
		"end before start": {"WEBVTT\n\n00:00.000 --> 00:01.000\nA\n\n00:03.000 --> 00:02.000\nB\n", "INVALID_WEBVTT", "line 6:"},
		"too large":        {"WEBVTT\n\n00:00.000 --> 00:01.000\n" + strings.Repeat("a", 524288) + "\n", "SUBTITLE_TOO_LARGE", ""},
	} {
		code, body := s.put(alice, video, "vi", "x", c.content)
		p := js[struct {
			Code   string `json:"code"`
			Detail string `json:"detail"`
		}](t, body)
		if code != 400 || p.Code != c.code || !strings.Contains(p.Detail, c.detail) {
			t.Errorf("%s: %d %s", name, code, body)
		}
	}
	if len(s.rows(video)) != 0 || len(s.obj.Keys("v/")) != 0 {
		t.Fatal("an invalid file was stored")
	}
}

func TestPlaybackSubtitlesPlainAndSignedOnPostgres(t *testing.T) {
	s := startSubtitles(t)
	owner := testutil.SeedUser(t, s.pg.Pool, "alice", nil, "")
	alice := &actor{owner.ID, "viewer,creator"}
	pub := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: owner.ID}).ID
	private := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: owner.ID, Visibility: "PRIVATE"}).ID
	hidden := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: owner.ID, Hidden: true}).ID
	none := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: owner.ID}).ID
	for _, v := range []uuid.UUID{pub, private, hidden} {
		for _, l := range []string{"vi", "en-US", "en"} {
			if code, body := s.put(alice, v, l, "label "+l, vttOK); code != http.StatusCreated {
				t.Fatalf("%s: %d %s", l, code, body)
			}
		}
	}
	type playback struct {
		Playback struct {
			HLSURL    string     `json:"hls_url"`
			ExpiresAt *time.Time `json:"expires_at"`
			Subtitles []track    `json:"subtitles"`
		} `json:"playback"`
	}
	get := func(a *actor, v uuid.UUID) (playback, string) {
		code, _, body := s.do(a, "GET", "/v1/videos/"+v.String(), "")
		if code != 200 {
			t.Fatalf("GET %s: %d %s", v, code, body)
		}
		return js[playback](t, body), string(body)
	}

	p, _ := get(nil, pub) // a public video: plain URLs for everybody, sorted by lang
	if len(p.Playback.Subtitles) != 3 || p.Playback.Subtitles[0].Lang != "en" || p.Playback.Subtitles[1].Lang != "en-US" || p.Playback.Subtitles[2].Lang != "vi" || p.Playback.ExpiresAt != nil {
		t.Fatalf("public: %+v", p.Playback)
	}
	for _, tr := range p.Playback.Subtitles {
		if !strings.HasPrefix(tr.URL, mediaBase+"/v/"+pub.String()+"/subtitles/"+tr.Lang+"-") || strings.Contains(tr.URL, "/s/") {
			t.Errorf("public track: %+v", tr)
		}
	}
	for name, c := range map[string]struct {
		a *actor
		v uuid.UUID
	}{"private": {alice, private}, "hidden": {alice, hidden}} { // not publicly watchable: signed, same expiry as hls_url
		p, _ := get(c.a, c.v)
		exp := fmt.Sprint(s.now.Add(6 * time.Hour).Unix())
		if !strings.HasPrefix(p.Playback.HLSURL, mediaBase+"/s/"+exp+"/") {
			t.Fatalf("%s: hls_url %s", name, p.Playback.HLSURL)
		}
		if len(p.Playback.Subtitles) != 3 || p.Playback.ExpiresAt == nil || !p.Playback.ExpiresAt.Equal(s.now.Add(6*time.Hour)) {
			t.Fatalf("%s: %+v", name, p.Playback)
		}
		for _, tr := range p.Playback.Subtitles {
			if !strings.HasPrefix(tr.URL, mediaBase+"/s/"+exp+"/") || !strings.Contains(tr.URL, "/v/"+c.v.String()+"/subtitles/"+tr.Lang+"-") {
				t.Errorf("%s track: %+v (hls %s)", name, tr, p.Playback.HLSURL)
			}
		}
	}
	if _, raw := get(nil, none); !strings.Contains(raw, `"subtitles":[]`) {
		t.Fatalf("no tracks: %s", raw)
	}
}

// Deleting the video removes its subtitle rows (cascade) and, through the media_prefix of video.deleted, the objects.
func TestDeletingTheVideoRemovesItsSubtitles(t *testing.T) {
	s := startSubtitles(t)
	owner := testutil.SeedUser(t, s.pg.Pool, "alice", nil, "")
	alice := &actor{owner.ID, "viewer,creator"}
	video := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: owner.ID}).ID
	other := testutil.SeedVideo(t, s.pg.Pool, testutil.Video{Owner: owner.ID}).ID
	for _, l := range []string{"vi", "en", "fr"} {
		s.put(alice, video, l, l, vttOK)
	}
	s.put(alice, other, "vi", "vi", vttOK)
	if len(s.keys(video)) != 3 {
		t.Fatalf("objects: %v", s.keys(video))
	}

	if code, _, b := s.do(alice, "DELETE", "/v1/videos/"+video.String(), ""); code != http.StatusNoContent {
		t.Fatalf("delete video: %d %s", code, b)
	}
	var n int
	_ = s.pg.Pool.QueryRow(context.Background(), `SELECT count(*) FROM media.video_subtitles WHERE video_id = $1`, video).Scan(&n)
	if n != 0 {
		t.Fatalf("%d subtitle rows survived the video", n)
	}
	// The event tells the janitor to purge v/{id}/: the subtitle objects are under that prefix.
	var payload []byte
	if err := s.pg.Pool.QueryRow(context.Background(), `SELECT payload FROM media.outbox WHERE subject='video.deleted' AND payload->'data'->>'video_id' = $1`, video.String()).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	var env struct {
		Data struct {
			MediaPrefix string `json:"media_prefix"`
		} `json:"data"`
	}
	_ = json.Unmarshal(payload, &env)
	if env.Data.MediaPrefix != "v/"+video.String()+"/" {
		t.Fatalf("media_prefix %q", env.Data.MediaPrefix)
	}
	if err := s.obj.DeletePrefix(env.Data.MediaPrefix); err != nil {
		t.Fatal(err)
	}
	if got := s.obj.Keys("v/" + video.String() + "/"); len(got) != 0 {
		t.Fatalf("objects left after the janitor: %v", got)
	}
	if got := s.keys(other); len(got) != 1 { // another video's track is untouched
		t.Fatalf("other video: %v", got)
	}
}
