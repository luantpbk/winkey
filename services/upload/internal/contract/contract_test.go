package contract

import "testing"

// The helper must really read upload.v1.yaml: it knows the documented statuses of createUpload and
// rejects an undocumented one.
func TestSpecKnowsCreateUpload(t *testing.T) {
	s := Load(t)
	for _, st := range []int{201, 400, 401, 403, 429} {
		loc, documented, err := s.responseSchema("POST", "/v1/uploads", st, "application/json")
		if st != 201 {
			loc, documented, err = s.responseSchema("POST", "/v1/uploads", st, "application/problem+json")
		}
		if err != nil || !documented || loc == "" {
			t.Errorf("status %d: loc=%q documented=%v err=%v", st, loc, documented, err)
		}
	}
	if _, documented, _ := s.responseSchema("POST", "/v1/uploads", 418, "application/json"); documented {
		t.Error("418 reported as documented")
	}
}

func TestCheckAcceptsAndRejects(t *testing.T) {
	s := Load(t)
	s.Check(t, "POST", "/v1/uploads", 201, "application/json",
		[]byte(`{"video_id":"0190d3a2-7b1c-7a3e-9a52-3f6d5b8c1e44","part_size":16777216,"part_count":1}`))
	s.Check(t, "POST", "/v1/uploads", 429, "application/problem+json; charset=utf-8",
		[]byte(`{"type":"/problems/too-many-requests","title":"Too Many Requests","status":429,"code":"UPLOAD_QUOTA_EXCEEDED","detail":"concurrent=3"}`))

	rec := &recorder{TB: t}
	s.Check(rec, "POST", "/v1/uploads", 201, "application/json", []byte(`{"video_id":"not-a-uuid"}`))
	if !rec.failed {
		t.Error("an invalid 201 body passed")
	}
	rec = &recorder{TB: t}
	s.Check(rec, "POST", "/v1/uploads", 418, "application/json", []byte(`{}`))
	if !rec.failed {
		t.Error("an undocumented status passed")
	}
	rec = &recorder{TB: t}
	CheckRetryAfter(rec, "0")
	if !rec.failed {
		t.Error("Retry-After 0 passed")
	}
	rec = &recorder{TB: t}
	CheckRetryAfter(rec, "soon")
	if !rec.failed {
		t.Error("a non-integer Retry-After passed")
	}
	if n := CheckRetryAfter(t, "60"); n != 60 {
		t.Errorf("Retry-After 60 -> %d", n)
	}
}

// recorder turns Errorf into a flag so the negative cases can be asserted.
type recorder struct {
	testing.TB
	failed bool
}

func (r *recorder) Errorf(string, ...any) { r.failed = true }
func (r *recorder) Helper()               {}
