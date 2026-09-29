package httpx

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/libs/go/obs"
)

func do(h http.Handler, method, path string, hdr map[string]string, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w
}

func TestProblemShape(t *testing.T) {
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/v1/uploads", nil)
	BadRequest(w, r, "SIZE_MISMATCH", "size differs", FieldError{Field: "size_bytes", Message: "bad"})

	if w.Code != 400 || w.Header().Get("Content-Type") != ProblemContentType {
		t.Fatalf("code=%d ct=%s", w.Code, w.Header().Get("Content-Type"))
	}
	var p Problem
	if err := json.Unmarshal(w.Body.Bytes(), &p); err != nil {
		t.Fatal(err)
	}
	if p.Code != "SIZE_MISMATCH" || p.Status != 400 || p.Title != "Bad Request" ||
		p.Instance != "/v1/uploads" || p.Type != "/problems/bad-request" || len(p.Errors) != 1 {
		t.Fatalf("unexpected problem: %+v", p)
	}
}

func TestRequestIDAndRecover(t *testing.T) {
	var logBuf bytes.Buffer
	log := obs.NewLoggerTo(&logBuf, "t", "info")
	r := NewRouter("t", log)
	r.Get("/boom", func(http.ResponseWriter, *http.Request) { panic("kaboom") })
	r.Get("/ok", func(w http.ResponseWriter, req *http.Request) {
		log.InfoContext(req.Context(), "inside")
		w.WriteHeader(204)
	})

	w := do(r, "GET", "/boom", nil, "")
	if w.Code != 500 || w.Header().Get("Content-Type") != ProblemContentType || w.Header().Get(RequestIDHeader) == "" {
		t.Fatalf("boom: %d %v", w.Code, w.Header())
	}
	if strings.Contains(w.Body.String(), "kaboom") {
		t.Fatal("panic value leaked to client")
	}

	logBuf.Reset()
	w = do(r, "GET", "/ok", map[string]string{RequestIDHeader: "abc-123"}, "")
	if w.Header().Get(RequestIDHeader) != "abc-123" {
		t.Fatal("request id not propagated")
	}
	if !strings.Contains(logBuf.String(), `"request_id":"abc-123"`) {
		t.Fatalf("log lacks request_id: %s", logBuf.String())
	}

	w = do(r, "GET", "/ok", map[string]string{RequestIDHeader: "bad id\n"}, "")
	if id := w.Header().Get(RequestIDHeader); id == "" || id == "bad id\n" {
		t.Fatalf("malformed id accepted: %q", id)
	}

	if w = do(r, "GET", "/missing", nil, ""); w.Code != 404 || w.Header().Get("Content-Type") != ProblemContentType {
		t.Fatalf("404 not a problem: %d", w.Code)
	}
}

func TestAuthenticateAndRequireRole(t *testing.T) {
	uid := ids.NewString()
	h := Authenticate(RequireRole(RoleCreator)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, _ := IdentityFrom(r.Context())
		if id.UserID.String() != uid {
			t.Errorf("uid %s", id.UserID)
		}
		w.WriteHeader(204)
	})))

	cases := []struct {
		name string
		hdr  map[string]string
		want int
	}{
		{"no identity", nil, 401},
		{"bad uuid", map[string]string{"X-User-Id": "nope"}, 401},
		{"viewer only", map[string]string{"X-User-Id": uid, "X-User-Roles": "viewer"}, 403},
		{"no roles", map[string]string{"X-User-Id": uid}, 403},
		{"creator", map[string]string{"X-User-Id": uid, "X-User-Roles": "viewer, creator"}, 204},
		{"admin implies role", map[string]string{"X-User-Id": uid, "X-User-Roles": "admin"}, 204},
	}
	for _, c := range cases {
		if w := do(h, "GET", "/", c.hdr, ""); w.Code != c.want {
			t.Errorf("%s: got %d want %d", c.name, w.Code, c.want)
		}
	}
}

func TestDecodeJSONStrict(t *testing.T) {
	type req struct {
		A int `json:"a"`
	}
	try := func(body string) (bool, int) {
		w := httptest.NewRecorder()
		r := httptest.NewRequest("POST", "/", strings.NewReader(body))
		var v req
		return DecodeJSON(w, r, &v), w.Code
	}
	if ok, _ := try(`{"a":1}`); !ok {
		t.Fatal("valid body rejected")
	}
	for _, b := range []string{`{"a":1,"b":2}`, `{"a":"x"}`, `{"a":1}{"a":2}`, ``} {
		if ok, code := try(b); ok || code != 400 {
			t.Errorf("body %q: ok=%v code=%d", b, ok, code)
		}
	}
}

func TestOptionalAuthenticate(t *testing.T) {
	uid := ids.NewString()
	h := OptionalAuthenticate(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, ok := IdentityFrom(r.Context())
		if ok {
			w.Header().Set("X-Seen", id.UserID.String()+"|"+strings.Join(id.Roles, ","))
		}
		w.WriteHeader(204)
	}))

	w := do(h, "GET", "/", nil, "")
	if w.Code != 204 || w.Header().Get("X-Seen") != "" {
		t.Fatalf("anonymous: %d seen=%q", w.Code, w.Header().Get("X-Seen"))
	}
	w = do(h, "GET", "/", map[string]string{"X-User-Id": uid, "X-User-Roles": "viewer, moderator"}, "")
	if w.Code != 204 || w.Header().Get("X-Seen") != uid+"|viewer,moderator" {
		t.Fatalf("authenticated: %d seen=%q", w.Code, w.Header().Get("X-Seen"))
	}
	// Present but malformed is a 401, not an anonymous request.
	for _, bad := range []string{"nope", "00000000-0000-0000-0000-000000000000"} {
		if w := do(h, "GET", "/", map[string]string{"X-User-Id": bad}, ""); w.Code != 401 {
			t.Errorf("X-User-Id %q: %d, want 401", bad, w.Code)
		}
	}
}
