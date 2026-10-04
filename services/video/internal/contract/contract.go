// Package contract validates real HTTP responses against the OpenAPI
// document contracts/openapi/video.v1.yaml (and the shared common.yaml), so a
// handler that drifts from the contract fails its tests.
//
// OpenAPI 3.1 schemas are JSON Schema 2020-12, so the component schemas are
// compiled directly with a JSON Schema validator (format assertions on: uuid,
// date-time, uri). Beyond the body it checks that the status code is
// documented for the operation and that the response media type matches.
package contract

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"sigs.k8s.io/yaml"
)

const (
	videoURL  = "https://winkey.test/openapi/video.v1.yaml"
	commonURL = "https://winkey.test/openapi/common.yaml"
)

// Spec is the loaded contract.
type Spec struct {
	video, common map[string]any
	compiler      *jsonschema.Compiler
	allowed       map[string]string // "METHOD path status" -> reason (tracking issue)

	// Check is called from concurrent requests. Compile mutates the compiler, so it
	// runs under mu.Lock, once per schema location (cache); Validate only reads
	// compiled schemas and runs under mu.RLock, so validations do not serialize.
	mu    sync.RWMutex
	cache map[string]*jsonschema.Schema
}

// schemaFor returns the compiled schema at loc, compiling it on first use.
func (s *Spec) schemaFor(loc string) (*jsonschema.Schema, error) {
	s.mu.RLock()
	sch, ok := s.cache[loc]
	s.mu.RUnlock()
	if ok {
		return sch, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if sch, ok := s.cache[loc]; ok {
		return sch, nil
	}
	sch, err := s.compiler.Compile(loc)
	if err != nil {
		return nil, err
	}
	s.cache[loc] = sch
	return sch, nil
}

// Load reads the contract files from the repository (walking up from this
// source file to find contracts/openapi).
func Load(t testing.TB) *Spec {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	dir := filepath.Dir(file)
	var root string
	for i := 0; i < 8; i++ {
		if st, err := os.Stat(filepath.Join(dir, "contracts", "openapi")); err == nil && st.IsDir() {
			root = filepath.Join(dir, "contracts", "openapi")
			break
		}
		dir = filepath.Dir(dir)
	}
	if root == "" {
		t.Fatal("contract: contracts/openapi not found")
	}
	files, err := os.OpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = files.Close() }()
	s := &Spec{compiler: jsonschema.NewCompiler(), allowed: map[string]string{}, cache: map[string]*jsonschema.Schema{}}
	s.compiler.DefaultDraft(jsonschema.Draft2020)
	s.compiler.AssertFormat()
	for _, d := range []struct {
		name, url string
		dst       *map[string]any
	}{{"video.v1.yaml", videoURL, &s.video}, {"common.yaml", commonURL, &s.common}} {
		raw, err := files.ReadFile(d.name)
		if err != nil {
			t.Fatal(err)
		}
		js, err := yaml.YAMLToJSON(raw)
		if err != nil {
			t.Fatalf("contract: %s: %v", d.name, err)
		}
		doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(js))
		if err != nil {
			t.Fatal(err)
		}
		if err := s.compiler.AddResource(d.url, doc); err != nil {
			t.Fatal(err)
		}
		m, ok := doc.(map[string]any)
		if !ok {
			t.Fatalf("contract: %s is not an object", d.name)
		}
		*d.dst = m
	}
	return s
}

func get(m map[string]any, path ...string) (any, bool) {
	var cur any = m
	for _, p := range path {
		mm, ok := cur.(map[string]any)
		if !ok {
			return nil, false
		}
		if cur, ok = mm[p]; !ok {
			return nil, false
		}
	}
	return cur, true
}

// responseSchema finds the schema location (URL#pointer) for the response of
// an operation, or "" when the response is documented without a body.
// documented is false when the status is not in the contract at all.
func (s *Spec) responseSchema(method, pathTemplate string, status int, mediaType string) (loc string, documented bool, err error) {
	resp, ok := get(s.video, "paths", pathTemplate, strings.ToLower(method), "responses", fmt.Sprint(status))
	if !ok {
		return "", false, nil
	}
	base := videoURL
	m := resp.(map[string]any)
	if ref, ok := m["$ref"].(string); ok { // e.g. ./common.yaml#/components/responses/NotFound
		file, frag, _ := strings.Cut(ref, "#")
		if !strings.HasSuffix(file, "common.yaml") {
			return "", true, fmt.Errorf("unsupported response ref %q", ref)
		}
		target, ok := get(s.common, strings.Split(strings.TrimPrefix(frag, "/"), "/")...)
		if !ok {
			return "", true, fmt.Errorf("unresolved response ref %q", ref)
		}
		m, base = target.(map[string]any), commonURL
	}
	content, ok := m["content"].(map[string]any)
	if !ok {
		return "", true, nil // documented, no body (e.g. 204)
	}
	media, ok := content[mediaType].(map[string]any)
	if !ok {
		return "", true, fmt.Errorf("media type %q not documented for %s %s %d (have %v)", mediaType, method, pathTemplate, status, keys(content))
	}
	schema, ok := media["schema"].(map[string]any)
	if !ok {
		return "", true, fmt.Errorf("no schema for %s %s %d", method, pathTemplate, status)
	}
	ref, ok := schema["$ref"].(string)
	if !ok {
		return "", true, fmt.Errorf("inline response schemas are not supported (%s %s %d)", method, pathTemplate, status)
	}
	if strings.HasPrefix(ref, "#") {
		return base + ref, true, nil
	}
	file, frag, _ := strings.Cut(ref, "#")
	if strings.HasSuffix(file, "common.yaml") {
		return commonURL + "#" + frag, true, nil
	}
	return "", true, fmt.Errorf("unsupported schema ref %q", ref)
}

func keys(m map[string]any) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	return out
}

// AllowUndocumentedProblem tolerates ONE response that the contract does not
// document yet, for a known gap tracked in an issue (contract changes are made
// by the architect, never here). The response must still be an RFC 9457
// application/problem+json body that validates against the shared Problem
// schema; every other undocumented status keeps failing. Remove the call when
// the contract is fixed.
func (s *Spec) AllowUndocumentedProblem(method, pathTemplate string, status int, issue string) {
	s.allowed[fmt.Sprintf("%s %s %d", method, pathTemplate, status)] = issue
}

// Check validates one response. pathTemplate is the OpenAPI path
// (e.g. /v1/videos/{video_id}); contentType is the response's Content-Type
// header (parameters such as charset are ignored).
func (s *Spec) Check(t testing.TB, method, pathTemplate string, status int, contentType string, body []byte) {
	t.Helper()
	mt, _, _ := strings.Cut(contentType, ";")
	mt = strings.TrimSpace(mt)
	loc, documented, err := s.responseSchema(method, pathTemplate, status, mt)
	if err != nil {
		t.Errorf("contract: %v", err)
		return
	}
	if !documented {
		if _, ok := s.allowed[fmt.Sprintf("%s %s %d", method, pathTemplate, status)]; ok && mt == "application/problem+json" {
			loc = commonURL + "#/components/schemas/Problem"
		} else {
			t.Errorf("contract: %s %s returned %d, which the contract does not document", method, pathTemplate, status)
			return
		}
	}
	if loc == "" {
		if len(bytes.TrimSpace(body)) != 0 {
			t.Errorf("contract: %s %s %d must have no body, got %q", method, pathTemplate, status, body)
		}
		return
	}
	schema, err := s.schemaFor(loc)
	if err != nil {
		t.Errorf("contract: compile %s: %v", loc, err)
		return
	}
	inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
	if err != nil {
		t.Errorf("contract: %s %s %d: body is not JSON: %v\n%s", method, pathTemplate, status, err, body)
		return
	}
	s.mu.RLock()
	err = schema.Validate(inst)
	s.mu.RUnlock()
	if err != nil {
		t.Errorf("contract: %s %s %d violates %s:\n%v\nbody: %s", method, pathTemplate, status, loc, err, body)
	}
}
