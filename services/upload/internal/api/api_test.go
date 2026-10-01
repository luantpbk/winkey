package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/httpx"
	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/services/upload/internal/domain"
	"github.com/luantpbk/winkey/services/upload/internal/partsize"
)

// --- fakes -------------------------------------------------------------

type fakeStore struct {
	mu       sync.Mutex
	videos   map[uuid.UUID]*domain.Video
	events   []domain.UploadedEvent
	progress float64

	usage     domain.Usage // what Create hands to the quota check
	checked   []bool       // per Create call: was a quota check passed?
	createErr error        // Create fails after the S3 upload was started (commit failure)
}

func newFakeStore() *fakeStore { return &fakeStore{videos: map[uuid.UUID]*domain.Video{}} }

func (s *fakeStore) Create(ctx context.Context, v domain.NewVideo, check func(domain.Usage) error, start func(context.Context) (string, error)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.checked = append(s.checked, check != nil)
	if check != nil {
		if err := check(s.usage); err != nil {
			return err
		}
	}
	uploadID, err := start(ctx)
	if err != nil {
		return err
	}
	if s.createErr != nil {
		return s.createErr
	}
	c := v.Video
	c.S3UploadID = uploadID
	s.videos[c.ID] = &c
	return nil
}
func (s *fakeStore) Get(_ context.Context, id uuid.UUID) (domain.Video, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if v, ok := s.videos[id]; ok {
		return *v, nil
	}
	return domain.Video{}, domain.ErrNotFound
}
func (s *fakeStore) Progress(context.Context, uuid.UUID) (float64, error) { return s.progress, nil }
func (s *fakeStore) MarkUploaded(_ context.Context, v domain.Video) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cur := s.videos[v.ID]
	if cur == nil || cur.Status != domain.StatusUploading {
		return false, nil
	}
	cur.Status, cur.S3UploadID = domain.StatusUploaded, ""
	s.events = append(s.events, domain.UploadedEvent{VideoID: v.ID.String(), OwnerID: v.OwnerID.String(),
		RawBucket: v.RawBucket, RawKey: v.RawKey, SizeBytes: v.SizeBytes, ContentType: v.ContentType})
	return true, nil
}
func (s *fakeStore) MarkFailed(_ context.Context, id uuid.UUID, msg string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cur := s.videos[id]
	if cur == nil || cur.Status != domain.StatusUploading {
		return false, nil
	}
	cur.Status, cur.Error = domain.StatusFailed, msg
	return true, nil
}
func (s *fakeStore) DeleteUploading(_ context.Context, id uuid.UUID) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if cur := s.videos[id]; cur != nil && cur.Status == domain.StatusUploading {
		delete(s.videos, id)
		return true, nil
	}
	return false, nil
}
func (s *fakeStore) StaleUploads(context.Context, time.Duration, int) ([]domain.Video, error) {
	return nil, nil
}

type fakeStorage struct {
	mu          sync.Mutex
	created     []string
	aborted     []string
	deleted     []string
	completeErr error
	createErr   error // CreateMultipart fails
	objectSize  int64
	completed   [][]domain.Part
}

func (f *fakeStorage) CreateMultipart(_ context.Context, bucket, key, ct string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.createErr != nil {
		return "", f.createErr
	}
	f.created = append(f.created, bucket+"/"+key+" "+ct)
	return "upload-1", nil
}
func (f *fakeStorage) PresignPart(_ context.Context, bucket, key, uid string, part int32, ttl time.Duration) (string, error) {
	return fmt.Sprintf("https://s3.winkey.vn/%s/%s?uploadId=%s&partNumber=%d&ttl=%d", bucket, key, uid, part, int(ttl.Seconds())), nil
}
func (f *fakeStorage) CompleteMultipart(_ context.Context, _, _, _ string, parts []domain.Part) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.completed = append(f.completed, parts)
	return f.completeErr
}
func (f *fakeStorage) AbortMultipart(_ context.Context, _, key, _ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.aborted = append(f.aborted, key)
	return nil
}
func (f *fakeStorage) HeadSize(context.Context, string, string) (int64, error) {
	return f.objectSize, nil
}
func (f *fakeStorage) DeleteObject(_ context.Context, _, key string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deleted = append(f.deleted, key)
	return nil
}
func (f *fakeStorage) Ping(context.Context, string) error { return nil }

// --- harness -----------------------------------------------------------

type env struct {
	h       http.Handler
	store   *fakeStore
	storage *fakeStorage
	owner   string
}

func newEnv() *env {
	e := &env{store: newFakeStore(), storage: &fakeStorage{}, owner: ids.NewString()}
	h := &Handler{
		Store: e.store, Storage: e.storage, RawBucket: "winkey-raw",
		Log: slog.New(slog.NewJSONHandler(io.Discard, nil)),
		Now: func() time.Time { return time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC) },
	}
	r := httpx.NewRouter("upload-test", h.Log)
	h.Routes(r)
	e.h = r
	return e
}

func (e *env) do(user, roles, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if user != "" {
		req.Header.Set("X-User-Id", user)
		req.Header.Set("X-User-Roles", roles)
	}
	w := httptest.NewRecorder()
	e.h.ServeHTTP(w, req)
	return w
}

func decode(t *testing.T, w *httptest.ResponseRecorder, v any) {
	t.Helper()
	if err := json.Unmarshal(w.Body.Bytes(), v); err != nil {
		t.Fatalf("bad json %q: %v", w.Body.String(), err)
	}
}

func problemCode(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	if ct := w.Header().Get("Content-Type"); ct != httpx.ProblemContentType {
		t.Fatalf("content-type %q, body %s", ct, w.Body.String())
	}
	var p httpx.Problem
	decode(t, w, &p)
	return p.Code
}

const validCreate = `{"title":"My clip","filename":"a.mp4","content_type":"video/mp4","size_bytes":104857600}`

func (e *env) createUpload(t *testing.T, size int64) (string, createResponse) {
	t.Helper()
	body := fmt.Sprintf(`{"title":"t","filename":"a.mp4","content_type":"video/mp4","size_bytes":%d}`, size)
	w := e.do(e.owner, "viewer,creator", "POST", "/v1/uploads", body)
	if w.Code != 201 {
		t.Fatalf("create: %d %s", w.Code, w.Body)
	}
	var res createResponse
	decode(t, w, &res)
	return res.VideoID, res
}

func partsBody(n int, etag string) string {
	var parts []string
	for i := 1; i <= n; i++ {
		parts = append(parts, fmt.Sprintf(`{"part_number":%d,"etag":"%s%d"}`, i, etag, i))
	}
	return `{"parts":[` + strings.Join(parts, ",") + `]}`
}

// --- tests -------------------------------------------------------------

func TestCreate(t *testing.T) {
	e := newEnv()
	w := e.do(e.owner, "creator", "POST", "/v1/uploads", validCreate)
	if w.Code != 201 {
		t.Fatalf("got %d %s", w.Code, w.Body)
	}
	var res createResponse
	decode(t, w, &res)
	if res.PartSize != 16*partsize.MiB || res.PartCount != 7 {
		t.Fatalf("part math: %+v", res)
	}
	v, err := e.store.Get(context.Background(), uuid.MustParse(res.VideoID))
	if err != nil {
		t.Fatal(err)
	}
	wantKey := e.owner + "/" + res.VideoID + "/source"
	if v.RawKey != wantKey || v.RawBucket != "winkey-raw" || v.Status != domain.StatusUploading || v.S3UploadID != "upload-1" {
		t.Fatalf("stored row: %+v", v)
	}
	if got := e.storage.created; len(got) != 1 || got[0] != "winkey-raw/"+wantKey+" video/mp4" {
		t.Fatalf("multipart: %v", got)
	}
}

func TestCreateAuthAndValidation(t *testing.T) {
	e := newEnv()
	if w := e.do("", "", "POST", "/v1/uploads", validCreate); w.Code != 401 {
		t.Errorf("no identity: %d", w.Code)
	}
	if w := e.do(e.owner, "viewer", "POST", "/v1/uploads", validCreate); w.Code != 403 {
		t.Errorf("viewer: %d", w.Code)
	}

	long := strings.Repeat("x", 101)
	cases := map[string]struct{ body, code string }{
		"empty title":      {`{"title":"","filename":"a","content_type":"video/mp4","size_bytes":1}`, "VALIDATION_ERROR"},
		"long title":       {`{"title":"` + long + `","filename":"a","content_type":"video/mp4","size_bytes":1}`, "VALIDATION_ERROR"},
		"bad content type": {`{"title":"t","filename":"a","content_type":"image/png","size_bytes":1}`, "VALIDATION_ERROR"},
		"bad visibility":   {`{"title":"t","filename":"a","content_type":"video/mp4","size_bytes":1,"visibility":"X"}`, "VALIDATION_ERROR"},
		"zero size":        {`{"title":"t","filename":"a","content_type":"video/mp4","size_bytes":0}`, "VALIDATION_ERROR"},
		"too large":        {`{"title":"t","filename":"a","content_type":"video/mp4","size_bytes":21474836481}`, "UPLOAD_TOO_LARGE"},
		"unknown field":    {`{"title":"t","filename":"a","content_type":"video/mp4","size_bytes":1,"x":1}`, "INVALID_JSON"},
	}
	for name, c := range cases {
		w := e.do(e.owner, "creator", "POST", "/v1/uploads", c.body)
		if w.Code != 400 || problemCode(t, w) != c.code {
			t.Errorf("%s: got %d %s", name, w.Code, w.Body)
		}
	}
	if len(e.storage.created) != 0 {
		t.Error("invalid requests must not touch storage")
	}
	// 20 GiB exactly is allowed.
	w := e.do(e.owner, "creator", "POST", "/v1/uploads",
		`{"title":"t","filename":"a","content_type":"video/mp4","size_bytes":21474836480}`)
	if w.Code != 201 {
		t.Errorf("20GiB: %d %s", w.Code, w.Body)
	}
}

func TestOwnershipIs404NeverForbidden(t *testing.T) {
	e := newEnv()
	id, _ := e.createUpload(t, 100<<20)
	other := ids.NewString()

	for _, c := range []struct{ method, path, body string }{
		{"GET", "/v1/uploads/" + id, ""},
		{"DELETE", "/v1/uploads/" + id, ""},
		{"POST", "/v1/uploads/" + id + "/parts", `{"part_numbers":[1]}`},
		{"POST", "/v1/uploads/" + id + "/complete", partsBody(7, "e")},
		{"GET", "/v1/uploads/" + ids.NewString(), ""}, // unknown id
		{"GET", "/v1/uploads/not-a-uuid", ""},
	} {
		w := e.do(other, "creator", c.method, c.path, c.body)
		if w.Code != 404 || problemCode(t, w) != "NOT_FOUND" {
			t.Errorf("%s %s: got %d", c.method, c.path, w.Code)
		}
	}
	if w := e.do(e.owner, "viewer", "GET", "/v1/uploads/"+id, ""); w.Code != 200 {
		t.Errorf("owner without creator role can still read status: %d", w.Code)
	}
}

func TestPresignParts(t *testing.T) {
	e := newEnv()
	id, res := e.createUpload(t, 100<<20) // 7 parts
	path := "/v1/uploads/" + id + "/parts"

	w := e.do(e.owner, "creator", "POST", path, `{"part_numbers":[3,1]}`)
	if w.Code != 200 {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	var out presignResponse
	decode(t, w, &out)
	if len(out.URLs) != 2 || out.URLs[0].PartNumber != 3 || out.URLs[1].PartNumber != 1 ||
		!strings.Contains(out.URLs[0].URL, "partNumber=3") || !strings.Contains(out.URLs[0].URL, "ttl=3600") {
		t.Fatalf("urls: %+v", out.URLs)
	}
	if !out.ExpiresAt.Equal(time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)) {
		t.Fatalf("expires_at %v", out.ExpiresAt)
	}

	for name, body := range map[string]string{
		"zero":      `{"part_numbers":[0]}`,
		"too big":   fmt.Sprintf(`{"part_numbers":[%d]}`, res.PartCount+1),
		"duplicate": `{"part_numbers":[1,1]}`,
		"empty":     `{"part_numbers":[]}`,
	} {
		if w := e.do(e.owner, "creator", "POST", path, body); w.Code != 400 {
			t.Errorf("%s: %d", name, w.Code)
		}
	}

	e.store.videos[uuid.MustParse(id)].Status = domain.StatusUploaded
	if w := e.do(e.owner, "creator", "POST", path, `{"part_numbers":[1]}`); w.Code != 409 || problemCode(t, w) != "INVALID_STATE" {
		t.Errorf("not uploading: %d", w.Code)
	}
}

func TestCompleteHappyPathAndIdempotency(t *testing.T) {
	e := newEnv()
	id, res := e.createUpload(t, 100<<20)
	e.storage.objectSize = 100 << 20
	path := "/v1/uploads/" + id + "/complete"

	// Parts arrive out of order: they must be sorted before completing.
	rev := `{"parts":[`
	for i := res.PartCount; i >= 1; i-- {
		rev += fmt.Sprintf(`{"part_number":%d,"etag":"\"e%d\""}`, i, i)
		if i > 1 {
			rev += ","
		}
	}
	rev += `]}`

	w := e.do(e.owner, "creator", "POST", path, rev)
	if w.Code != 202 {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	var st statusResponse
	decode(t, w, &st)
	if st.Status != "UPLOADED" || st.Progress != 0 || st.Error != nil || st.VideoID != id {
		t.Fatalf("status: %+v", st)
	}
	got := e.storage.completed[0]
	if len(got) != res.PartCount || got[0].Number != 1 || got[len(got)-1].Number != int32(res.PartCount) {
		t.Fatalf("parts not sorted: %+v", got)
	}
	if len(e.store.events) != 1 || e.store.events[0].SizeBytes != 100<<20 || e.store.events[0].RawKey != e.owner+"/"+id+"/source" {
		t.Fatalf("events: %+v", e.store.events)
	}

	// Idempotent: repeat (even with a garbage body shape) → 202, no second event / S3 call.
	w = e.do(e.owner, "creator", "POST", path, `{"parts":[{"part_number":1,"etag":"x"}]}`)
	if w.Code != 202 || len(e.store.events) != 1 || len(e.storage.completed) != 1 {
		t.Fatalf("repeat: %d events=%d completes=%d", w.Code, len(e.store.events), len(e.storage.completed))
	}

	// Later states are reported as-is, READY at 100%.
	e.store.videos[uuid.MustParse(id)].Status = domain.StatusReady
	w = e.do(e.owner, "creator", "POST", path, partsBody(res.PartCount, "e"))
	decode(t, w, &st)
	if w.Code != 202 || st.Status != "READY" || st.Progress != 100 {
		t.Fatalf("ready: %d %+v", w.Code, st)
	}
}

func TestCompleteRejectsBadPartLists(t *testing.T) {
	e := newEnv()
	id, res := e.createUpload(t, 100<<20)
	path := "/v1/uploads/" + id + "/complete"

	missing := partsBody(res.PartCount-1, "e")
	dup := strings.Replace(partsBody(res.PartCount, "e"), `"part_number":2`, `"part_number":1`, 1)
	gap := strings.Replace(partsBody(res.PartCount, "e"), fmt.Sprintf(`"part_number":%d`, res.PartCount), fmt.Sprintf(`"part_number":%d`, res.PartCount+1), 1)
	emptyETag := `{"parts":[` + strings.Repeat(`{"part_number":1,"etag":" "},`, res.PartCount-1) + `{"part_number":2,"etag":" "}]}`
	for name, body := range map[string]string{"missing": missing, "duplicate": dup, "gap": gap, "empty etag": emptyETag} {
		w := e.do(e.owner, "creator", "POST", path, body)
		if w.Code != 400 || problemCode(t, w) != "INVALID_PARTS" {
			t.Errorf("%s: %d %s", name, w.Code, w.Body)
		}
	}
	if len(e.storage.completed) != 0 {
		t.Error("storage must not be called for an invalid list")
	}
}

func TestCompleteSizeMismatch(t *testing.T) {
	e := newEnv()
	id, res := e.createUpload(t, 100<<20)
	e.storage.objectSize = 100<<20 - 1

	w := e.do(e.owner, "creator", "POST", "/v1/uploads/"+id+"/complete", partsBody(res.PartCount, "e"))
	if w.Code != 400 || problemCode(t, w) != "SIZE_MISMATCH" {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	v := e.store.videos[uuid.MustParse(id)]
	if v.Status != domain.StatusFailed || v.Error == "" {
		t.Fatalf("row: %+v", v)
	}
	if len(e.store.events) != 0 {
		t.Error("no event may be emitted on mismatch")
	}
	if len(e.storage.deleted) != 1 {
		t.Error("mismatched object should be deleted")
	}
	// A FAILED upload cannot be completed again.
	if w := e.do(e.owner, "creator", "POST", "/v1/uploads/"+id+"/complete", partsBody(res.PartCount, "e")); w.Code != 409 {
		t.Errorf("after failure: %d", w.Code)
	}
}

func TestCompleteInvalidPartFromS3(t *testing.T) {
	e := newEnv()
	id, res := e.createUpload(t, 100<<20)
	e.storage.completeErr = fmt.Errorf("x: %w", domain.ErrInvalidPart)
	w := e.do(e.owner, "creator", "POST", "/v1/uploads/"+id+"/complete", partsBody(res.PartCount, "e"))
	if w.Code != 400 || problemCode(t, w) != "INVALID_PARTS" {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if e.store.videos[uuid.MustParse(id)].Status != domain.StatusUploading {
		t.Error("status must stay UPLOADING so the client can retry")
	}
}

func TestAbort(t *testing.T) {
	e := newEnv()
	id, _ := e.createUpload(t, 100<<20)

	if w := e.do(e.owner, "creator", "DELETE", "/v1/uploads/"+id, ""); w.Code != 204 {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if len(e.storage.aborted) != 1 || len(e.store.videos) != 0 {
		t.Fatalf("aborted=%v rows=%d", e.storage.aborted, len(e.store.videos))
	}
	if w := e.do(e.owner, "creator", "GET", "/v1/uploads/"+id, ""); w.Code != 404 {
		t.Errorf("after delete: %d", w.Code)
	}

	id2, _ := e.createUpload(t, 100<<20)
	e.store.videos[uuid.MustParse(id2)].Status = domain.StatusProcessing
	w := e.do(e.owner, "creator", "DELETE", "/v1/uploads/"+id2, "")
	if w.Code != 409 || problemCode(t, w) != "INVALID_STATE" {
		t.Errorf("not uploading: %d", w.Code)
	}
}

func TestGetStatusReportsProgressAndError(t *testing.T) {
	e := newEnv()
	id, _ := e.createUpload(t, 100<<20)
	v := e.store.videos[uuid.MustParse(id)]

	v.Status = domain.StatusProcessing
	e.store.progress = 42.5
	var st statusResponse
	w := e.do(e.owner, "creator", "GET", "/v1/uploads/"+id, "")
	decode(t, w, &st)
	if w.Code != 200 || st.Status != "PROCESSING" || st.Progress != 42.5 || st.Error != nil {
		t.Fatalf("%d %+v", w.Code, st)
	}

	v.Status, v.Error = domain.StatusFailed, "bad input"
	w = e.do(e.owner, "creator", "GET", "/v1/uploads/"+id, "")
	st = statusResponse{}
	decode(t, w, &st)
	if st.Status != "FAILED" || st.Error == nil || *st.Error != "bad input" {
		t.Fatalf("%+v", st)
	}
	if !strings.Contains(w.Body.String(), `"error":"bad input"`) {
		t.Fatalf("error field missing: %s", w.Body)
	}

	// `error` must be present (null) even when there is none.
	v.Status, v.Error = domain.StatusUploading, ""
	w = e.do(e.owner, "creator", "GET", "/v1/uploads/"+id, "")
	if !strings.Contains(w.Body.String(), `"error":null`) {
		t.Fatalf("expected explicit null: %s", w.Body)
	}
}
