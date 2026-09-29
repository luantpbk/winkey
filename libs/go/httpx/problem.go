// Package httpx contains the HTTP plumbing shared by Go services: chi
// middlewares, RFC 9457 problem responses and gateway identity handling.
package httpx

import (
	"encoding/json"
	"net/http"
	"strings"
)

// ProblemContentType is the media type of RFC 9457 problem documents.
const ProblemContentType = "application/problem+json"

// FieldError describes one invalid field of a request.
type FieldError struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

// Problem is an RFC 9457 problem document extended with the Winkey `code`.
type Problem struct {
	Type     string       `json:"type"`
	Title    string       `json:"title"`
	Status   int          `json:"status"`
	Detail   string       `json:"detail,omitempty"`
	Instance string       `json:"instance,omitempty"`
	Code     string       `json:"code,omitempty"`
	Errors   []FieldError `json:"errors,omitempty"`
}

// NewProblem builds a Problem whose type is /problems/<slug of title>.
func NewProblem(status int, code, detail string) *Problem {
	title := http.StatusText(status)
	return &Problem{
		Type:   "/problems/" + strings.ReplaceAll(strings.ToLower(title), " ", "-"),
		Title:  title,
		Status: status,
		Detail: detail,
		Code:   code,
	}
}

// WithErrors attaches field-level validation errors.
func (p *Problem) WithErrors(errs ...FieldError) *Problem {
	p.Errors = append(p.Errors, errs...)
	return p
}

// Error implements error so handlers can return a *Problem up the stack.
func (p *Problem) Error() string { return p.Code + ": " + p.Detail }

// WriteProblem writes p as application/problem+json, filling `instance` with
// the request path.
func WriteProblem(w http.ResponseWriter, r *http.Request, p *Problem) {
	if p.Instance == "" && r != nil {
		p.Instance = r.URL.Path
	}
	w.Header().Set("Content-Type", ProblemContentType)
	w.WriteHeader(p.Status)
	_ = json.NewEncoder(w).Encode(p)
}

// Shorthands for the statuses the contracts use.

func BadRequest(w http.ResponseWriter, r *http.Request, code, detail string, errs ...FieldError) {
	WriteProblem(w, r, NewProblem(http.StatusBadRequest, code, detail).WithErrors(errs...))
}

func Unauthorized(w http.ResponseWriter, r *http.Request) {
	WriteProblem(w, r, NewProblem(http.StatusUnauthorized, "UNAUTHORIZED", "authentication required"))
}

func Forbidden(w http.ResponseWriter, r *http.Request, detail string) {
	WriteProblem(w, r, NewProblem(http.StatusForbidden, "FORBIDDEN", detail))
}

func NotFound(w http.ResponseWriter, r *http.Request) {
	WriteProblem(w, r, NewProblem(http.StatusNotFound, "NOT_FOUND", "resource not found"))
}

func Conflict(w http.ResponseWriter, r *http.Request, code, detail string) {
	WriteProblem(w, r, NewProblem(http.StatusConflict, code, detail))
}

func Internal(w http.ResponseWriter, r *http.Request) {
	WriteProblem(w, r, NewProblem(http.StatusInternalServerError, "INTERNAL", "internal error"))
}

// MaxBodyBytes is the default limit applied by DecodeJSON.
const MaxBodyBytes = 1 << 20

// DecodeJSON decodes a JSON request body into dst, rejecting unknown fields
// and trailing data. On failure it writes a 400 problem and returns false.
func DecodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, MaxBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		BadRequest(w, r, "INVALID_JSON", "request body is not valid JSON for this endpoint")
		return false
	}
	if dec.More() {
		BadRequest(w, r, "INVALID_JSON", "unexpected data after JSON body")
		return false
	}
	return true
}

// WriteJSON writes v as JSON with the given status.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
