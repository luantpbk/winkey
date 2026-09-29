package contract

import (
	"fmt"
	"strings"
	"sync"
	"testing"
)

// recorder captures failures instead of failing the real test.
type recorder struct {
	testing.TB
	errs []string
}

func (r *recorder) Errorf(format string, args ...any) {
	r.errs = append(r.errs, fmt.Sprintf(format, args...))
}
func (r *recorder) Helper() {}

const goodVideo = `{
  "id":"0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c0d","title":"t","description":"",
  "owner":{"id":"0192f5e0-0000-7000-8000-000000000001","handle":"alice","display_name":"Alice","avatar_url":null},
  "visibility":"PUBLIC","status":"READY","duration_ms":1000,"width":1920,"height":1080,
  "view_count":1,"like_count":0,"published_at":"2026-10-01T08:00:00Z","created_at":"2026-10-01T07:00:00Z",
  "playback":{"hls_url":"https://media.winkey.vn/v/x/a1/hls/master.m3u8","thumbnail_url":"https://media.winkey.vn/v/x/a1/thumb/poster.jpg",
    "renditions":[{"name":"1080p","width":1920,"height":1080,"bitrate_kbps":5000}]}}`

func check(t *testing.T, s *Spec, method, path string, status int, ct, body string) []string {
	t.Helper()
	r := &recorder{TB: t}
	s.Check(r, method, path, status, ct, []byte(body))
	return r.errs
}

func TestCheckAcceptsValidAndRejectsInvalidBodies(t *testing.T) {
	s := Load(t)
	if errs := check(t, s, "GET", "/v1/videos/{video_id}", 200, "application/json", goodVideo); len(errs) != 0 {
		t.Fatalf("valid video rejected: %v", errs)
	}
	for name, body := range map[string]string{
		"missing required field": `{"id":"0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c0d"}`,
		"bad uuid":               replace(goodVideo, `"id":"0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c0d"`, `"id":"nope"`),
		"bad enum":               replace(goodVideo, `"status":"READY"`, `"status":"DONE"`),
		"bad date":               replace(goodVideo, `"created_at":"2026-10-01T07:00:00Z"`, `"created_at":"yesterday"`),
		"wrong type":             replace(goodVideo, `"view_count":1`, `"view_count":"1"`),
		"bad rendition name":     replace(goodVideo, `"1080p"`, `"big"`),
		"bad handle":             replace(goodVideo, `"handle":"alice"`, `"handle":"a"`),
		"not json":               `<html>`,
	} {
		if errs := check(t, s, "GET", "/v1/videos/{video_id}", 200, "application/json", body); len(errs) == 0 {
			t.Errorf("%s: the invalid body was accepted", name)
		}
	}
}

func TestCheckStatusAndMediaTypeAreEnforced(t *testing.T) {
	s := Load(t)
	problem := `{"type":"/problems/not-found","title":"Not Found","status":404,"code":"NOT_FOUND"}`
	if errs := check(t, s, "GET", "/v1/videos/{video_id}", 404, "application/problem+json", problem); len(errs) != 0 {
		t.Fatalf("documented 404 rejected: %v", errs)
	}
	if errs := check(t, s, "GET", "/v1/videos/{video_id}", 404, "application/json", problem); len(errs) == 0 {
		t.Error("a 404 must be application/problem+json")
	}
	if errs := check(t, s, "GET", "/v1/videos/{video_id}", 409, "application/problem+json", problem); len(errs) == 0 {
		t.Error("an undocumented status was accepted")
	}
	if errs := check(t, s, "GET", "/v1/nope", 200, "application/json", `{}`); len(errs) == 0 {
		t.Error("an undocumented path was accepted")
	}
	if errs := check(t, s, "DELETE", "/v1/videos/{video_id}", 204, "", ""); len(errs) != 0 {
		t.Fatalf("204 without body rejected: %v", errs)
	}
	if errs := check(t, s, "DELETE", "/v1/videos/{video_id}", 204, "application/json", `{"x":1}`); len(errs) == 0 {
		t.Error("a 204 with a body was accepted")
	}
}

func TestAllowUndocumentedProblemIsNarrow(t *testing.T) {
	s := Load(t)
	problem := `{"type":"/problems/conflict","title":"Conflict","status":409,"code":"INVALID_CURSOR"}`
	if errs := check(t, s, "GET", "/v1/studio/videos", 409, "application/problem+json", problem); len(errs) == 0 {
		t.Fatal("the studio 409 must fail until it is explicitly allowed")
	}
	s.AllowUndocumentedProblem("GET", "/v1/studio/videos", 409, "issue")
	if errs := check(t, s, "GET", "/v1/studio/videos", 409, "application/problem+json", problem); len(errs) != 0 {
		t.Fatalf("allowed problem rejected: %v", errs)
	}
	// Still validated: wrong media type, or a body that is not a Problem.
	if errs := check(t, s, "GET", "/v1/studio/videos", 409, "application/json", problem); len(errs) == 0 {
		t.Error("allowed status must still be problem+json")
	}
	if errs := check(t, s, "GET", "/v1/studio/videos", 409, "application/problem+json", `{"oops":true}`); len(errs) == 0 {
		t.Error("allowed status must still validate against the Problem schema")
	}
	// Other undocumented responses keep failing.
	if errs := check(t, s, "GET", "/v1/studio/videos", 422, "application/problem+json", problem); len(errs) == 0 {
		t.Error("another undocumented status was accepted")
	}
	if errs := check(t, s, "GET", "/v1/videos", 418, "application/problem+json", problem); len(errs) == 0 {
		t.Error("undocumented status on another operation was accepted")
	}
}

func replace(s, old, new string) string {
	if !strings.Contains(s, old) {
		panic("test fixture does not contain " + old)
	}
	return strings.Replace(s, old, new, 1)
}

// Check is used from concurrent requests: compiling schemas for the first time
// from many goroutines while others validate must be race free (run with -race).
func TestCheckIsSafeForConcurrentUse(t *testing.T) {
	s := Load(t)
	problem := `{"type":"/problems/not-found","title":"Not Found","status":404,"code":"NOT_FOUND"}`
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for j := 0; j < 20; j++ {
				switch (i + j) % 4 {
				case 0:
					s.Check(t, "GET", "/v1/videos/{video_id}", 200, "application/json", []byte(goodVideo))
				case 1:
					s.Check(t, "GET", "/v1/videos/{video_id}", 404, "application/problem+json", []byte(problem))
				case 2:
					s.Check(t, "POST", "/v1/videos/{video_id}/views", 202, "application/json", []byte(`{"counted":true}`))
				default:
					s.Check(t, "POST", "/v1/videos/{video_id}/views", 429, "application/problem+json",
						[]byte(`{"type":"/problems/too-many-requests","title":"Too Many Requests","status":429,"code":"RATE_LIMITED"}`))
				}
			}
		}(i)
	}
	wg.Wait()
}
