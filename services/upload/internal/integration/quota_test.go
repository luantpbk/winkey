package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"github.com/luantpbk/winkey/libs/go/httpx"
	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/libs/go/testkit"
	"github.com/luantpbk/winkey/services/upload/internal/contract"
	"github.com/luantpbk/winkey/services/upload/internal/quota"
)

const (
	gib      = int64(1) << 30
	mib      = int64(1) << 20
	maxBytes = 20 * gib // the smallest UPLOAD_DAILY_BYTES the service accepts
)

// quotaStack is one stack for all the quota cases; every case uses its own owner, so cases do not
// see each other's rows.
type quotaStack struct {
	*stack
	spec *contract.Spec
}

// api sends one request and checks the response against upload.v1.yaml (status documented, body
// schema, media type, and Retry-After on a 429). pathTemplate is the OpenAPI path.
func (q *quotaStack) api(t *testing.T, owner, roles, method, pathTemplate, path string, body any) (int, http.Header, []byte) {
	t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, q.srv.URL+path, rd)
	req.Header.Set("X-User-Id", owner)
	req.Header.Set("X-User-Roles", roles)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Error(err)
		return 0, nil, nil
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	q.spec.Check(t, method, pathTemplate, resp.StatusCode, resp.Header.Get("Content-Type"), raw)
	if resp.StatusCode == http.StatusTooManyRequests {
		contract.CheckRetryAfter(t, resp.Header.Get("Retry-After"))
	}
	return resp.StatusCode, resp.Header, raw
}

type created struct {
	code       int
	videoID    string
	retryAfter int
	problem    httpx.Problem
}

func (q *quotaStack) create(t *testing.T, owner, roles string, size int64) created {
	t.Helper()
	code, hdr, raw := q.api(t, owner, roles, "POST", "/v1/uploads", "/v1/uploads", map[string]any{
		"title": "clip", "filename": "clip.mp4", "content_type": "video/mp4", "size_bytes": size,
	})
	c := created{code: code}
	switch code {
	case 201:
		var r createResp
		_ = json.Unmarshal(raw, &r)
		c.videoID = r.VideoID
	case 429:
		_ = json.Unmarshal(raw, &c.problem)
		fmt.Sscan(hdr.Get("Retry-After"), &c.retryAfter)
	}
	return c
}

// seed inserts a row of the owner created `age` ago, in the given status, reached through the legal
// status transitions (UPLOADING -> UPLOADED | FAILED, UPLOADED -> PROCESSING).
func (q *quotaStack) seed(t *testing.T, owner string, age time.Duration, size int64, status string) {
	t.Helper()
	ctx := context.Background()
	id := ids.New()
	if _, err := q.pg.Pool.Exec(ctx, `
		INSERT INTO media.videos (id, owner_id, title, status, raw_bucket, raw_key, content_type, size_bytes, created_at)
		VALUES ($1, $2, 'seed', 'UPLOADING', $3, $4, 'video/mp4', $5, now() - make_interval(secs => $6))`,
		id, owner, testkit.RawBucket, owner+"/"+id.String()+"/source", size, age.Seconds()); err != nil {
		t.Fatal(err)
	}
	// createUpload writes the ledger row in the same transaction as the video row; the seed does too.
	if _, err := q.pg.Pool.Exec(ctx, `
		INSERT INTO media.upload_ledger (video_id, owner_id, size_bytes, created_at)
		VALUES ($1, $2, $3, now() - make_interval(secs => $4))`, id, owner, size, age.Seconds()); err != nil {
		t.Fatal(err)
	}
	var path []string
	switch status {
	case "UPLOADING":
	case "UPLOADED", "FAILED":
		path = []string{status}
	case "PROCESSING":
		path = []string{"UPLOADED", "PROCESSING"}
	default:
		t.Fatalf("seed: unsupported status %s", status)
	}
	for _, st := range path {
		if _, err := q.pg.Pool.Exec(ctx, `UPDATE media.videos SET status = $2::media.video_status WHERE id = $1`, id, st); err != nil {
			t.Fatal(err)
		}
	}
}

func (q *quotaStack) rows(t *testing.T, owner string) int {
	t.Helper()
	var n int
	if err := q.pg.Pool.QueryRow(context.Background(), `SELECT count(*) FROM media.videos WHERE owner_id = $1`, owner).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// multiparts lists the open S3 multipart uploads under the owner's prefix.
func (q *quotaStack) multiparts(t *testing.T, owner string) int {
	t.Helper()
	out, err := q.s3.ListMultipartUploads(context.Background(), &s3.ListMultipartUploadsInput{
		Bucket: aws.String(testkit.RawBucket), Prefix: aws.String(owner + "/"),
	})
	if err != nil {
		t.Fatal(err)
	}
	return len(out.Uploads)
}

func wantQuota429(t *testing.T, c created, limit string) {
	t.Helper()
	if c.code != 429 {
		t.Fatalf("got %d, want 429 %s", c.code, limit)
	}
	if c.problem.Code != "UPLOAD_QUOTA_EXCEEDED" || !strings.Contains(c.problem.Detail, limit) {
		t.Fatalf("problem %+v, want UPLOAD_QUOTA_EXCEEDED naming %s", c.problem, limit)
	}
}

func TestUploadQuota(t *testing.T) {
	q := &quotaStack{
		stack: startQuota(t, quota.Limits{MaxConcurrent: 3, DailyCount: 20, DailyBytes: maxBytes}),
		spec:  contract.Load(t),
	}
	creator := "creator"

	t.Run("concurrent: 3 open uploads, the 4th is refused, completing one frees a slot", func(t *testing.T) {
		owner := ids.NewString()
		// The first upload gets its parts so that it can be completed later.
		var first createResp
		var parts []map[string]any
		first, parts = (&stack{srv: q.srv, pg: q.pg, owner: owner, s3: q.s3}).upload(t, mib, mib)
		for range 2 {
			if c := q.create(t, owner, creator, mib); c.code != 201 {
				t.Fatalf("create: %d", c.code)
			}
		}
		if got := q.multiparts(t, owner); got != 3 {
			t.Fatalf("open multipart uploads = %d, want 3", got)
		}
		c := q.create(t, owner, creator, mib)
		wantQuota429(t, c, "concurrent")
		if c.retryAfter != 60 {
			t.Errorf("Retry-After = %d, want 60", c.retryAfter)
		}
		if !strings.Contains(c.problem.Detail, "3") {
			t.Errorf("detail lacks the limit value: %q", c.problem.Detail)
		}
		if q.rows(t, owner) != 3 || q.multiparts(t, owner) != 3 {
			t.Fatalf("a refused call left state behind: rows %d, multiparts %d", q.rows(t, owner), q.multiparts(t, owner))
		}

		code, _, _ := q.api(t, owner, creator, "POST", "/v1/uploads/{video_id}/complete", "/v1/uploads/"+first.VideoID+"/complete", map[string]any{"parts": parts})
		if code != 202 {
			t.Fatalf("complete: %d", code)
		}
		if c := q.create(t, owner, creator, mib); c.code != 201 {
			t.Fatalf("after completing one, the next create got %d", c.code)
		}
		wantQuota429(t, q.create(t, owner, creator, mib), "concurrent")
	})

	t.Run("concurrent also counts UPLOADING rows older than 24 hours", func(t *testing.T) {
		owner := ids.NewString()
		for range 3 {
			q.seed(t, owner, 30*time.Hour, mib, "UPLOADING")
		}
		wantQuota429(t, q.create(t, owner, creator, mib), "concurrent")
	})

	t.Run("daily_count: 20 in 24 hours, FAILED and PROCESSING rows included", func(t *testing.T) {
		owner := ids.NewString()
		statuses := []string{"UPLOADED", "FAILED", "PROCESSING", "FAILED", "UPLOADED"}
		for i := range 20 {
			// Spread over the day; the oldest is 23 h 30 min old. None is UPLOADING, so only the daily count can trip.
			age := 23*time.Hour + 30*time.Minute - time.Duration(i)*time.Hour
			q.seed(t, owner, age, mib, statuses[i%len(statuses)])
		}
		c := q.create(t, owner, creator, mib)
		wantQuota429(t, c, "daily_count")
		if !strings.Contains(c.problem.Detail, "20") {
			t.Errorf("detail lacks the limit value: %q", c.problem.Detail)
		}
		// The oldest counted row is 23 h 30 min old: it leaves the window in 30 min.
		if c.retryAfter < 30*60-30 || c.retryAfter > 30*60+30 {
			t.Errorf("Retry-After = %d, want about %d", c.retryAfter, 30*60)
		}
		if q.rows(t, owner) != 20 || q.multiparts(t, owner) != 0 {
			t.Fatalf("a refused call left state behind: rows %d, multiparts %d", q.rows(t, owner), q.multiparts(t, owner))
		}
	})

	t.Run("daily_count: the 20th passes, the 21st does not", func(t *testing.T) {
		owner := ids.NewString()
		for range 19 {
			q.seed(t, owner, time.Hour, mib, "FAILED")
		}
		if c := q.create(t, owner, creator, mib); c.code != 201 {
			t.Fatalf("the 20th: %d", c.code)
		}
		wantQuota429(t, q.create(t, owner, creator, mib), "daily_count")
	})

	t.Run("daily_bytes: the new upload's own bytes count", func(t *testing.T) {
		owner := ids.NewString()
		q.seed(t, owner, time.Hour, maxBytes-mib, "UPLOADED") // leaves exactly 1 MiB
		c := q.create(t, owner, creator, mib+1)
		wantQuota429(t, c, "daily_bytes")
		if !strings.Contains(c.problem.Detail, fmt.Sprint(maxBytes)) {
			t.Errorf("detail lacks the limit value: %q", c.problem.Detail)
		}
		if want := 23 * 3600; c.retryAfter < want-30 || c.retryAfter > want+30 { // the seeded row is 1 h old
			t.Errorf("Retry-After = %d, want about %d", c.retryAfter, want)
		}
		if c := q.create(t, owner, creator, mib); c.code != 201 { // exactly at the limit
			t.Fatalf("exactly at the limit: %d", c.code)
		}
		wantQuota429(t, q.create(t, owner, creator, 1), "daily_bytes")
	})

	t.Run("a row older than 24 hours does not count, one just inside does", func(t *testing.T) {
		owner := ids.NewString()
		q.seed(t, owner, 24*time.Hour+time.Second, maxBytes, "UPLOADED") // 24h + 1s: outside
		for range 19 {
			q.seed(t, owner, 24*time.Hour+time.Second, mib, "FAILED")
		}
		if c := q.create(t, owner, creator, maxBytes); c.code != 201 {
			t.Fatalf("rows 24 h + 1 s old were counted: %d %+v", c.code, c.problem)
		}

		inside := ids.NewString()
		q.seed(t, inside, 24*time.Hour-10*time.Second, maxBytes, "UPLOADED") // 10 s inside the window
		c := q.create(t, inside, creator, mib)
		wantQuota429(t, c, "daily_bytes")
		if c.retryAfter < 1 || c.retryAfter > 40 {
			t.Errorf("Retry-After = %d, want about 10", c.retryAfter)
		}
	})

	t.Run("admin passes every limit", func(t *testing.T) {
		owner := ids.NewString()
		for range 3 {
			q.seed(t, owner, time.Hour, maxBytes/4, "UPLOADING")
		}
		wantQuota429(t, q.create(t, owner, creator, mib), "concurrent")
		if c := q.create(t, owner, "creator,admin", mib); c.code != 201 {
			t.Fatalf("admin: %d", c.code)
		}
	})

	t.Run("quotas are per owner", func(t *testing.T) {
		busy, other := ids.NewString(), ids.NewString()
		for range 3 {
			q.seed(t, busy, time.Hour, mib, "UPLOADING")
		}
		wantQuota429(t, q.create(t, busy, creator, mib), "concurrent")
		if c := q.create(t, other, creator, mib); c.code != 201 {
			t.Fatalf("another owner: %d", c.code)
		}
	})

	t.Run("race: 10 concurrent creates with a limit of 3 make exactly 3 rows", func(t *testing.T) {
		owner := ids.NewString()
		var wg sync.WaitGroup
		results := make([]created, 10)
		start := make(chan struct{})
		for i := range results {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				results[i] = q.create(t, owner, creator, mib)
			}()
		}
		close(start)
		wg.Wait()
		ok, refused := 0, 0
		for _, r := range results {
			switch r.code {
			case 201:
				ok++
			case 429:
				refused++
				wantQuota429(t, r, "concurrent")
			default:
				t.Errorf("unexpected status %d", r.code)
			}
		}
		if ok != 3 || refused != 7 {
			t.Fatalf("created %d, refused %d; want 3 and 7", ok, refused)
		}
		if n := q.rows(t, owner); n != 3 {
			t.Fatalf("rows = %d, want exactly 3", n)
		}
		if n := q.multiparts(t, owner); n != 3 {
			t.Fatalf("multipart uploads = %d, want exactly 3 (a refused call must not create one)", n)
		}
	})
}
