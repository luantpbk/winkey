// Package integration runs the upload flow against real PostgreSQL, NATS and
// Garage (testkit). It skips when Docker is unavailable.
package integration

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/google/uuid"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/luantpbk/winkey/libs/go/httpx"
	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/libs/go/outbox"
	"github.com/luantpbk/winkey/libs/go/s3x"
	"github.com/luantpbk/winkey/libs/go/testkit"
	"github.com/luantpbk/winkey/services/upload/internal/api"
	"github.com/luantpbk/winkey/services/upload/internal/domain"
	"github.com/luantpbk/winkey/services/upload/internal/janitor"
	"github.com/luantpbk/winkey/services/upload/internal/quota"
	"github.com/luantpbk/winkey/services/upload/internal/storage"
	"github.com/luantpbk/winkey/services/upload/internal/store"
)

type stack struct {
	srv   *httptest.Server
	pg    *testkit.Postgres
	nats  *testkit.NATS
	s3    *s3.Client
	owner string
	store *store.Postgres
	stor  *storage.S3
}

func start(t *testing.T) *stack { return startQuota(t, quota.Limits{}) }

// startQuota is start with the upload quota limits of ADR-027 (zero fields: no limit).
func startQuota(t *testing.T, limits quota.Limits) *stack {
	t.Helper()
	pg := testkit.StartPostgres(t)
	ns := testkit.StartNATS(t)
	g := testkit.StartGarage(t)

	// Public endpoint == the endpoint the test reaches Garage on, so presigned
	// URLs can be exercised for real.
	s3c, err := s3x.New(s3x.Config{
		Endpoint: g.Endpoint, PublicEndpoint: g.Endpoint, Region: g.Region,
		AccessKeyID: g.AccessKey, SecretAccessKey: g.SecretKey,
	})
	if err != nil {
		t.Fatal(err)
	}
	stor := storage.New(s3c)
	st := &store.Postgres{Pool: pg.Pool}
	log := slog.New(slog.NewJSONHandler(io.Discard, nil))
	h := &api.Handler{Store: st, Storage: stor, RawBucket: testkit.RawBucket, Log: log, Quota: limits}
	r := httpx.NewRouter("upload-test", log)
	h.Routes(r)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)

	outbox.SetProducer("upload-svc")
	relay := &outbox.Relay{Pool: pg.Pool, Publisher: outbox.JetStreamPublisher{JS: ns.JS}, Schema: "media",
		Log: log, Listen: true}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() { _ = relay.Run(ctx) }()

	return &stack{srv: srv, pg: pg, nats: ns, s3: g.S3Client(), owner: ids.NewString(), store: st, stor: stor}
}

func (s *stack) call(t *testing.T, user, method, path string, body any, out any) int {
	t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, s.srv.URL+path, rd)
	req.Header.Set("X-User-Id", user)
	req.Header.Set("X-User-Roles", "creator")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			t.Fatalf("%s %s: %v: %s", method, path, err, raw)
		}
	}
	return resp.StatusCode
}

// putPart uploads through the presigned URL exactly as a browser would and
// returns the ETag response header.
func putPart(t *testing.T, url string, data []byte) string {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPut, url, bytes.NewReader(data))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("PUT part: %d %s", resp.StatusCode, b)
	}
	etag := resp.Header.Get("ETag")
	if etag == "" {
		t.Fatal("no ETag in response")
	}
	return etag
}

type createResp struct {
	VideoID   string `json:"video_id"`
	PartSize  int64  `json:"part_size"`
	PartCount int    `json:"part_count"`
}

func (s *stack) upload(t *testing.T, size int64, declared int64) (createResp, []map[string]any) {
	t.Helper()
	var c createResp
	code := s.call(t, s.owner, "POST", "/v1/uploads", map[string]any{
		"title": "clip", "filename": "clip.mp4", "content_type": "video/mp4", "size_bytes": declared,
	}, &c)
	if code != 201 {
		t.Fatalf("create: %d", code)
	}
	nums := make([]int, c.PartCount)
	for i := range nums {
		nums[i] = i + 1
	}
	var pre struct {
		URLs []struct {
			PartNumber int    `json:"part_number"`
			URL        string `json:"url"`
		} `json:"urls"`
	}
	if code := s.call(t, s.owner, "POST", "/v1/uploads/"+c.VideoID+"/parts", map[string]any{"part_numbers": nums}, &pre); code != 200 {
		t.Fatalf("presign: %d", code)
	}
	var parts []map[string]any
	remaining := size
	for _, u := range pre.URLs {
		n := c.PartSize
		if remaining < n {
			n = remaining
		}
		remaining -= n
		buf := make([]byte, n)
		_, _ = rand.Read(buf)
		parts = append(parts, map[string]any{"part_number": u.PartNumber, "etag": putPart(t, u.URL, buf)})
	}
	return c, parts
}

func TestFullFlowMultipart(t *testing.T) {
	s := start(t)
	ctx := context.Background()

	// 40 MiB + 1 byte: 3 parts (16 + 16 + 8 MiB + 1).
	size := int64(40<<20) + 1
	c, parts := s.upload(t, size, size)
	if c.PartCount != 3 {
		t.Fatalf("part_count %d", c.PartCount)
	}

	var st struct {
		Status string `json:"status"`
	}
	if code := s.call(t, s.owner, "POST", "/v1/uploads/"+c.VideoID+"/complete", map[string]any{"parts": parts}, &st); code != 202 || st.Status != "UPLOADED" {
		t.Fatalf("complete: %d %+v", code, st)
	}
	// Idempotent.
	if code := s.call(t, s.owner, "POST", "/v1/uploads/"+c.VideoID+"/complete", map[string]any{"parts": parts}, &st); code != 202 {
		t.Fatalf("repeat complete: %d", code)
	}

	// The raw object exists with the right size and key layout.
	key := s.owner + "/" + c.VideoID + "/source"
	head, err := s.s3.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(testkit.RawBucket), Key: &key})
	if err != nil || aws.ToInt64(head.ContentLength) != size {
		t.Fatalf("head: %v %v", head, err)
	}

	// Row state + exactly one outbox event, then delivered to JetStream.
	var status string
	var uploadID *string
	if err := s.pg.Pool.QueryRow(ctx, `SELECT status::text, s3_upload_id FROM media.videos WHERE id=$1`, c.VideoID).Scan(&status, &uploadID); err != nil {
		t.Fatal(err)
	}
	if status != "UPLOADED" || uploadID != nil {
		t.Fatalf("row: %s %v", status, uploadID)
	}
	var events int
	_ = s.pg.Pool.QueryRow(ctx, `SELECT count(*) FROM media.outbox WHERE subject='video.uploaded' AND payload->'data'->>'video_id'=$1`, c.VideoID).Scan(&events)
	if events != 1 {
		t.Fatalf("outbox events %d", events)
	}
	cons, err := s.nats.JS.CreateOrUpdateConsumer(ctx, "VIDEO", jetstream.ConsumerConfig{FilterSubject: "video.uploaded", AckPolicy: jetstream.AckExplicitPolicy})
	if err != nil {
		t.Fatal(err)
	}
	batch, err := cons.Fetch(1, jetstream.FetchMaxWait(10*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for m := range batch.Messages() {
		n++
		var env outbox.Envelope
		_ = json.Unmarshal(m.Data(), &env)
		var data domain.UploadedEvent
		_ = json.Unmarshal(env.Data, &data)
		if data.VideoID != c.VideoID || data.SizeBytes != size || data.RawKey != key || env.Producer != "upload-svc" {
			t.Fatalf("event: %+v %+v", env, data)
		}
		_ = m.Ack()
	}
	if n != 1 {
		t.Fatal("video.uploaded not delivered")
	}

	// Another user sees 404.
	if code := s.call(t, ids.NewString(), "GET", "/v1/uploads/"+c.VideoID, nil, nil); code != 404 {
		t.Fatalf("stranger: %d", code)
	}
}

func TestSizeMismatchFailsVideo(t *testing.T) {
	s := start(t)
	actual := int64(20 << 20)
	c, parts := s.upload(t, actual, actual+5) // declared bigger than what is uploaded
	// part_count for declared size is still 2, so both parts were uploaded.
	var prob httpx.Problem
	code := s.call(t, s.owner, "POST", "/v1/uploads/"+c.VideoID+"/complete", map[string]any{"parts": parts}, &prob)
	if code != 400 || prob.Code != "SIZE_MISMATCH" {
		t.Fatalf("%d %+v", code, prob)
	}
	var status string
	_ = s.pg.Pool.QueryRow(context.Background(), `SELECT status::text FROM media.videos WHERE id=$1`, c.VideoID).Scan(&status)
	if status != "FAILED" {
		t.Fatalf("status %s", status)
	}
}

func TestAbortAndJanitor(t *testing.T) {
	s := start(t)
	ctx := context.Background()

	mk := func() createResp {
		var r createResp
		if code := s.call(t, s.owner, "POST", "/v1/uploads", map[string]any{
			"title": "t", "filename": "a.mp4", "content_type": "video/mp4", "size_bytes": 1 << 20,
		}, &r); code != 201 {
			t.Fatalf("create %d", code)
		}
		return r
	}
	c := mk()
	if code := s.call(t, s.owner, "DELETE", "/v1/uploads/"+c.VideoID, nil, nil); code != 204 {
		t.Fatalf("abort: %d", code)
	}
	var n int
	_ = s.pg.Pool.QueryRow(ctx, `SELECT count(*) FROM media.videos WHERE id=$1`, c.VideoID).Scan(&n)
	if n != 0 {
		t.Fatal("row not deleted")
	}

	// Janitor: backdate an UPLOADING row and sweep.
	stale := mk()
	fresh := mk()
	if _, err := s.pg.Pool.Exec(ctx, `UPDATE media.videos SET created_at = now() - interval '25 hours' WHERE id=$1`, uuid.MustParse(stale.VideoID)); err != nil {
		t.Fatal(err)
	}
	j := &janitor.Janitor{Store: s.store, Storage: s.stor, Log: slog.New(slog.NewJSONHandler(io.Discard, nil))}
	deleted, err := j.Sweep(ctx)
	if err != nil || deleted != 1 {
		t.Fatalf("sweep: %d %v", deleted, err)
	}
	if code := s.call(t, s.owner, "GET", "/v1/uploads/"+fresh.VideoID, nil, nil); code != 200 {
		t.Fatalf("fresh upload must survive: %d", code)
	}
	if code := s.call(t, s.owner, "GET", "/v1/uploads/"+stale.VideoID, nil, nil); code != 404 {
		t.Fatalf("stale upload must be gone: %d", code)
	}
}
