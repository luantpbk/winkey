package s3x

import (
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// fakeS3 is a minimal path-style S3 server: enough of the protocol (real XML
// bodies and error codes) to exercise the SDK plumbing without a network.
type fakeS3 struct {
	t   *testing.T
	srv *httptest.Server

	mu       sync.Mutex
	objs     map[string]fakeObj // "bucket/key"
	calls    []string           // "METHOD path?rawquery"
	failBulk bool               // POST ?delete answers 501, forcing the per-object fallback
	pageSize int                // max keys per list page (0 = 1000)
}

type fakeObj struct {
	data         []byte
	contentType  string
	cacheControl string
}

func newFake(t *testing.T) *fakeS3 {
	f := &fakeS3{t: t, objs: map[string]fakeObj{}, pageSize: 3}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeS3) put(bucket, key string, data []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.objs[bucket+"/"+key] = fakeObj{data: data}
}

func (f *fakeS3) has(bucket, key string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, ok := f.objs[bucket+"/"+key]
	return ok
}

func (f *fakeS3) count(prefix string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for k := range f.objs {
		if strings.HasPrefix(k, prefix) {
			n++
		}
	}
	return n
}

func (f *fakeS3) callsMatching(sub string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if strings.Contains(c, sub) {
			n++
		}
	}
	return n
}

func s3Error(w http.ResponseWriter, status int, code string) { s3ErrorMsg(w, status, code, code) }

func s3ErrorMsg(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/xml")
	w.WriteHeader(status)
	fmt.Fprintf(w, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>%s</Code><Message>%s</Message><RequestId>1</RequestId></Error>`, code, msg)
}

func (f *fakeS3) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.calls = append(f.calls, r.Method+" "+r.URL.Path+"?"+r.URL.RawQuery)
	f.mu.Unlock()

	bucket, key, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, "/"), "/")
	q := r.URL.Query()

	switch {
	// ---- bucket level
	case key == "" && r.Method == http.MethodHead:
		if bucket == "nobucket" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusOK)
	case key == "" && r.Method == http.MethodGet && q.Get("list-type") == "2":
		f.list(w, bucket, q)
	case key == "" && r.Method == http.MethodPost && q.Has("delete"):
		f.bulkDelete(w, r, bucket)

	// ---- multipart
	case r.Method == http.MethodPost && q.Has("uploads"):
		fmt.Fprintf(w, `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><Bucket>%s</Bucket><Key>%s</Key><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>`, bucket, key)
	case r.Method == http.MethodPost && q.Has("uploadId"):
		switch q.Get("uploadId") {
		case "gone":
			s3Error(w, http.StatusNotFound, "NoSuchUpload")
		case "badpart":
			s3Error(w, http.StatusBadRequest, "InvalidPart")
		case "toosmall":
			s3Error(w, http.StatusBadRequest, "EntityTooSmall")
		case "nodata": // what Garage answers when no part was uploaded
			s3ErrorMsg(w, http.StatusBadRequest, "InvalidRequest", "Bad request: No data was uploaded")
		case "othererror":
			s3ErrorMsg(w, http.StatusBadRequest, "InvalidRequest", "something else is wrong with the request")
		default:
			fmt.Fprintf(w, `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult><Bucket>%s</Bucket><Key>%s</Key><ETag>"done"</ETag></CompleteMultipartUploadResult>`, bucket, key)
		}
	case r.Method == http.MethodDelete && q.Has("uploadId"):
		if q.Get("uploadId") == "gone" {
			s3Error(w, http.StatusNotFound, "NoSuchUpload")
			return
		}
		w.WriteHeader(http.StatusNoContent)

	// ---- objects
	case r.Method == http.MethodPut:
		body, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.objs[bucket+"/"+key] = fakeObj{data: body, contentType: r.Header.Get("Content-Type"), cacheControl: r.Header.Get("Cache-Control")}
		f.mu.Unlock()
		w.Header().Set("ETag", `"etag"`)
	case r.Method == http.MethodHead:
		f.mu.Lock()
		o, ok := f.objs[bucket+"/"+key]
		f.mu.Unlock()
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(o.data)))
		w.Header().Set("ETag", `"etag"`)
		w.Header().Set("Content-Type", "video/mp4")
	case r.Method == http.MethodGet:
		f.mu.Lock()
		o, ok := f.objs[bucket+"/"+key]
		f.mu.Unlock()
		if !ok {
			s3Error(w, http.StatusNotFound, "NoSuchKey")
			return
		}
		f.get(w, r, o)
	case r.Method == http.MethodDelete:
		f.mu.Lock()
		delete(f.objs, bucket+"/"+key)
		f.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	default:
		s3Error(w, http.StatusNotImplemented, "NotImplemented")
	}
}

func (f *fakeS3) get(w http.ResponseWriter, r *http.Request, o fakeObj) {
	data := o.data
	rng := r.Header.Get("Range")
	if rng == "" {
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		_, _ = w.Write(data)
		return
	}
	var start, end int
	fmt.Sscanf(strings.TrimPrefix(rng, "bytes="), "%d-%d", &start, &end)
	if start >= len(data) {
		s3Error(w, http.StatusRequestedRangeNotSatisfiable, "InvalidRange")
		return
	}
	end = min(end, len(data)-1)
	w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(data)))
	w.Header().Set("Content-Length", strconv.Itoa(end-start+1))
	w.WriteHeader(http.StatusPartialContent)
	_, _ = w.Write(data[start : end+1])
}

type listResult struct {
	XMLName               xml.Name `xml:"ListBucketResult"`
	Name                  string   `xml:"Name"`
	Prefix                string   `xml:"Prefix"`
	KeyCount              int      `xml:"KeyCount"`
	MaxKeys               int      `xml:"MaxKeys"`
	IsTruncated           bool     `xml:"IsTruncated"`
	NextContinuationToken string   `xml:"NextContinuationToken,omitempty"`
	Contents              []struct {
		Key  string `xml:"Key"`
		Size int    `xml:"Size"`
	} `xml:"Contents"`
	CommonPrefixes []struct {
		Prefix string `xml:"Prefix"`
	} `xml:"CommonPrefixes"`
}

func (f *fakeS3) list(w http.ResponseWriter, bucket string, q map[string][]string) {
	get := func(k string) string {
		if v := q[k]; len(v) > 0 {
			return v[0]
		}
		return ""
	}
	prefix, delim, token := get("prefix"), get("delimiter"), get("continuation-token")
	f.mu.Lock()
	var keys []string
	for full := range f.objs {
		if b, k, _ := strings.Cut(full, "/"); b == bucket && strings.HasPrefix(k, prefix) {
			keys = append(keys, k)
		}
	}
	f.mu.Unlock()
	sort.Strings(keys)

	// Collapse into entries: either an object or a common prefix.
	type entry struct {
		key      string
		isPrefix bool
	}
	var entries []entry
	seen := map[string]bool{}
	for _, k := range keys {
		rest := strings.TrimPrefix(k, prefix)
		if delim != "" {
			if i := strings.Index(rest, delim); i >= 0 {
				cp := prefix + rest[:i+1]
				if !seen[cp] {
					seen[cp] = true
					entries = append(entries, entry{cp, true})
				}
				continue
			}
		}
		entries = append(entries, entry{k, false})
	}
	// Like real S3 the continuation token is key based (the last key of the
	// previous page), so deleting earlier pages while listing is safe.
	start := 0
	if token != "" {
		start = sort.Search(len(entries), func(i int) bool { return entries[i].key > token })
	}
	size := f.pageSize
	if size == 0 {
		size = 1000
	}
	end := min(start+size, len(entries))
	res := listResult{Name: bucket, Prefix: prefix, MaxKeys: size}
	for _, e := range entries[start:end] {
		if e.isPrefix {
			res.CommonPrefixes = append(res.CommonPrefixes, struct {
				Prefix string `xml:"Prefix"`
			}{e.key})
		} else {
			res.Contents = append(res.Contents, struct {
				Key  string `xml:"Key"`
				Size int    `xml:"Size"`
			}{e.key, 1})
		}
	}
	res.KeyCount = end - start
	if end < len(entries) {
		res.IsTruncated, res.NextContinuationToken = true, entries[end-1].key
	}
	w.Header().Set("Content-Type", "application/xml")
	_ = xml.NewEncoder(w).Encode(res)
}

func (f *fakeS3) bulkDelete(w http.ResponseWriter, r *http.Request, bucket string) {
	if f.failBulk {
		s3Error(w, http.StatusNotImplemented, "NotImplemented")
		return
	}
	var req struct {
		Objects []struct {
			Key string `xml:"Key"`
		} `xml:"Object"`
	}
	body, _ := io.ReadAll(r.Body)
	_ = xml.Unmarshal(body, &req)
	f.mu.Lock()
	for _, o := range req.Objects {
		delete(f.objs, bucket+"/"+o.Key)
	}
	f.mu.Unlock()
	w.Header().Set("Content-Type", "application/xml")
	fmt.Fprint(w, `<?xml version="1.0" encoding="UTF-8"?><DeleteResult></DeleteResult>`)
}
