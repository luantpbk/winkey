package api

import (
	"context"
	"fmt"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/services/upload/internal/contract"
	"github.com/luantpbk/winkey/services/upload/internal/domain"
)

const mib = int64(1) << 20

// fakeAudio implements domain.AudioStore over the fake videos.
type fakeAudio struct {
	mu     sync.Mutex
	videos *fakeStore
	tracks map[uuid.UUID]*domain.AudioTrack
	events []domain.AudioUploadedEvent
}

func (f *fakeAudio) CreateAudioTrack(ctx context.Context, t domain.AudioTrack, check func(domain.Usage) error, start func(context.Context) (string, error)) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if check != nil {
		if err := check(f.videos.usage); err != nil {
			return err
		}
	}
	n := 0
	for _, o := range f.tracks {
		if o.VideoID != t.VideoID {
			continue
		}
		n++
		if o.Lang == t.Lang && o.Kind == t.Kind {
			return domain.ErrAudioTrackExists
		}
	}
	if n >= domain.MaxAudioTracks {
		return domain.ErrTooManyAudioTracks
	}
	uploadID, err := start(ctx)
	if err != nil {
		return err
	}
	if t.IsDefault {
		for _, o := range f.tracks {
			if o.VideoID == t.VideoID {
				o.IsDefault = false
			}
		}
	}
	c := t
	c.S3UploadID, c.UpdatedAt = uploadID, time.Date(2026, 10, 14, 8, 0, 0, 0, time.UTC)
	f.tracks[c.ID] = &c
	return nil
}
func (f *fakeAudio) GetAudioTrack(_ context.Context, videoID, trackID uuid.UUID) (domain.AudioTrack, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if t, ok := f.tracks[trackID]; ok && t.VideoID == videoID {
		return *t, nil
	}
	return domain.AudioTrack{}, domain.ErrNotFound
}
func (f *fakeAudio) MarkAudioUploaded(_ context.Context, t domain.AudioTrack) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	cur := f.tracks[t.ID]
	if cur == nil || cur.Status != domain.StatusUploading {
		return false, nil
	}
	cur.Status, cur.S3UploadID = domain.StatusUploaded, ""
	f.events = append(f.events, domain.AudioUploadedEvent{VideoID: t.VideoID.String(), TrackID: t.ID.String(), Lang: t.Lang, Kind: t.Kind})
	return true, nil
}
func (f *fakeAudio) MarkAudioFailed(_ context.Context, id uuid.UUID, code string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	cur := f.tracks[id]
	if cur == nil || cur.Status != domain.StatusUploading {
		return false, nil
	}
	cur.Status, cur.Error = domain.StatusFailed, code
	return true, nil
}
func (f *fakeAudio) DeleteUploadingAudio(_ context.Context, id uuid.UUID) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if cur := f.tracks[id]; cur != nil && cur.Status == domain.StatusUploading {
		delete(f.tracks, id)
		return true, nil
	}
	return false, nil
}
func (f *fakeAudio) StaleAudioUploads(context.Context, time.Duration, int) ([]domain.AudioTrack, error) {
	return nil, nil
}

func audioBody(lang, kind string, size int64) string {
	return fmt.Sprintf(`{"lang":%q,"label":"Thuyết minh","kind":%q,"filename":"vi.wav","content_type":"audio/wav","size_bytes":%d}`, lang, kind, size)
}

// check validates the response against upload.v1.yaml.
func check(t *testing.T, spec *contract.Spec, method, path string, w *httptest.ResponseRecorder) {
	t.Helper()
	spec.Check(t, method, path, w.Code, w.Header().Get("Content-Type"), w.Body.Bytes())
}

const (
	pathTracks   = "/v1/uploads/{video_id}/audio-tracks"
	pathTrack    = "/v1/uploads/{video_id}/audio-tracks/{track_id}"
	pathParts    = "/v1/uploads/{video_id}/audio-tracks/{track_id}/parts"
	pathComplete = "/v1/uploads/{video_id}/audio-tracks/{track_id}/complete"
)

func TestAudioTrackUploadFlow(t *testing.T) {
	spec := contract.Load(t)
	e := newEnv()
	vid, _ := e.createUpload(t, 100*mib)
	base := "/v1/uploads/" + vid + "/audio-tracks"

	w := e.do(e.owner, "viewer,creator", "POST", base, `{"lang":"vi","label":"Thuyết minh","kind":"voiceover","is_default":true,"filename":"vi.wav","content_type":"audio/wav","size_bytes":52428800}`)
	check(t, spec, "POST", pathTracks, w)
	if w.Code != 201 {
		t.Fatalf("create: %d %s", w.Code, w.Body)
	}
	var cr createAudioResponse
	decode(t, w, &cr)
	if cr.PartSize != 16*mib || cr.PartCount != 4 {
		t.Errorf("parts %d x %d", cr.PartCount, cr.PartSize)
	}
	tid := uuid.MustParse(cr.TrackID)
	tr := e.audio.tracks[tid]
	if want := e.owner + "/" + vid + "/audio/" + cr.TrackID + "/source"; tr.RawKey != want || !tr.IsDefault || tr.RawBucket != "winkey-raw" {
		t.Errorf("track = %+v, want key %s", tr, want)
	}
	if got := e.storage.created[len(e.storage.created)-1]; got != "winkey-raw/"+tr.RawKey+" audio/wav" {
		t.Errorf("multipart created as %q", got)
	}

	w = e.do(e.owner, "viewer,creator", "POST", base+"/"+cr.TrackID+"/parts", `{"part_numbers":[1,4]}`)
	check(t, spec, "POST", pathParts, w)
	if w.Code != 200 {
		t.Fatalf("presign: %d %s", w.Code, w.Body)
	}
	w = e.do(e.owner, "viewer,creator", "POST", base+"/"+cr.TrackID+"/parts", `{"part_numbers":[5]}`)
	if w.Code != 400 || problemCode(t, w) != "INVALID_PART_NUMBER" {
		t.Fatalf("part 5: %d %s", w.Code, w.Body)
	}

	e.storage.objectSize = 50 * mib
	w = e.do(e.owner, "viewer,creator", "POST", base+"/"+cr.TrackID+"/complete", partsBody(4, "e"))
	check(t, spec, "POST", pathComplete, w)
	if w.Code != 202 {
		t.Fatalf("complete: %d %s", w.Code, w.Body)
	}
	var res audioTrackResponse
	decode(t, w, &res)
	if res.Status != domain.StatusUploaded || res.ID != cr.TrackID || res.Lang != "vi" || res.Kind != "voiceover" {
		t.Errorf("complete = %+v", res)
	}
	if len(e.audio.events) != 1 || e.audio.events[0].TrackID != cr.TrackID {
		t.Fatalf("events = %+v", e.audio.events)
	}
	// Idempotent: no second event, no second CompleteMultipart.
	w = e.do(e.owner, "viewer,creator", "POST", base+"/"+cr.TrackID+"/complete", partsBody(4, "e"))
	check(t, spec, "POST", pathComplete, w)
	if w.Code != 202 || len(e.audio.events) != 1 || len(e.storage.completed) != 1 {
		t.Fatalf("second complete: %d events=%d completes=%d", w.Code, len(e.audio.events), len(e.storage.completed))
	}
	// Uploaded tracks cannot be aborted here (video-svc deletes them).
	w = e.do(e.owner, "viewer,creator", "DELETE", base+"/"+cr.TrackID, "")
	check(t, spec, "DELETE", pathTrack, w)
	if w.Code != 409 || problemCode(t, w) != "INVALID_STATE" {
		t.Fatalf("abort uploaded: %d %s", w.Code, w.Body)
	}
}

func TestAudioTrackCreateRules(t *testing.T) {
	spec := contract.Load(t)
	e := newEnv()
	vid, _ := e.createUpload(t, mib)
	base := "/v1/uploads/" + vid + "/audio-tracks"
	post := func(body string) *httptest.ResponseRecorder {
		w := e.do(e.owner, "viewer,creator", "POST", base, body)
		check(t, spec, "POST", pathTracks, w)
		return w
	}

	if w := post(audioBody("vi", "voiceover", mib)); w.Code != 201 {
		t.Fatalf("first: %d %s", w.Code, w.Body)
	}
	if w := post(audioBody("vi", "voiceover", mib)); w.Code != 409 || problemCode(t, w) != "AUDIO_TRACK_EXISTS" {
		t.Fatalf("duplicate: %d %s", w.Code, w.Body)
	}
	for _, l := range []string{"en", "fr", "de", "ja", "ko", "zh-TW", "th"} {
		if w := post(audioBody(l, "dub", mib)); w.Code != 201 {
			t.Fatalf("%s: %d %s", l, w.Code, w.Body)
		}
	}
	if w := post(audioBody("es", "dub", mib)); w.Code != 409 || problemCode(t, w) != "TOO_MANY_AUDIO_TRACKS" {
		t.Fatalf("ninth: %d %s", w.Code, w.Body)
	}

	for name, tc := range map[string]struct {
		body, code string
	}{
		"bad lang":     {audioBody("Vietnamese", "dub", mib), "VALIDATION_ERROR"},
		"bad kind":     {audioBody("vi", "karaoke", mib), "VALIDATION_ERROR"},
		"video type":   {`{"lang":"vi","label":"x","kind":"dub","filename":"a.mp4","content_type":"video/mp4","size_bytes":1}`, "VALIDATION_ERROR"},
		"empty label":  {`{"lang":"vi","label":"","kind":"dub","filename":"a.wav","content_type":"audio/wav","size_bytes":1}`, "VALIDATION_ERROR"},
		"over 4 GiB":   {audioBody("vi", "dub", 4<<30+1), "UPLOAD_TOO_LARGE"},
		"unknown prop": {`{"lang":"vi","label":"x","kind":"dub","filename":"a.wav","content_type":"audio/wav","size_bytes":1,"x":1}`, ""},
	} {
		t.Run(name, func(t *testing.T) {
			w := post(tc.body)
			if w.Code != 400 {
				t.Fatalf("%d %s", w.Code, w.Body)
			}
			if tc.code != "" && problemCode(t, w) != tc.code {
				t.Errorf("code %s", w.Body)
			}
		})
	}
}

// Another user's video, a track of another video and malformed ids are all 404, never 403.
func TestAudioTrackOwnership(t *testing.T) {
	spec := contract.Load(t)
	e := newEnv()
	vid, _ := e.createUpload(t, mib)
	other, _ := e.createUpload(t, mib)
	w := e.do(e.owner, "viewer,creator", "POST", "/v1/uploads/"+vid+"/audio-tracks", audioBody("vi", "dub", mib))
	var cr createAudioResponse
	decode(t, w, &cr)

	stranger := ids.NewString()
	for _, c := range []struct{ user, method, path, tmpl string }{
		{stranger, "POST", "/v1/uploads/" + vid + "/audio-tracks", pathTracks},
		{stranger, "DELETE", "/v1/uploads/" + vid + "/audio-tracks/" + cr.TrackID, pathTrack},
		{stranger, "POST", "/v1/uploads/" + vid + "/audio-tracks/" + cr.TrackID + "/complete", pathComplete},
		{e.owner, "DELETE", "/v1/uploads/" + other + "/audio-tracks/" + cr.TrackID, pathTrack},
		{e.owner, "DELETE", "/v1/uploads/" + vid + "/audio-tracks/nope", pathTrack},
	} {
		body := audioBody("en", "dub", mib)
		if c.tmpl == pathComplete {
			body = partsBody(1, "e")
		}
		w := e.do(c.user, "viewer,creator", c.method, c.path, body)
		check(t, spec, c.method, c.tmpl, w)
		if w.Code != 404 {
			t.Errorf("%s %s by %s: %d", c.method, c.path, c.user, w.Code)
		}
	}
	if w := e.do("", "", "POST", "/v1/uploads/"+vid+"/audio-tracks", audioBody("en", "dub", mib)); w.Code != 401 {
		t.Errorf("anonymous: %d", w.Code)
	}
	// ROLE1 (ADR-046): the owner without the creator role cannot add tracks.
	w = e.do(e.owner, "viewer", "POST", "/v1/uploads/"+vid+"/audio-tracks", audioBody("en", "dub", mib))
	check(t, spec, "POST", pathTracks, w)
	if w.Code != 403 {
		t.Errorf("owner without creator: %d", w.Code)
	}
}

func TestAudioTrackAbortAndSizeMismatch(t *testing.T) {
	spec := contract.Load(t)
	e := newEnv()
	vid, _ := e.createUpload(t, mib)
	base := "/v1/uploads/" + vid + "/audio-tracks"
	var a, b createAudioResponse
	decode(t, e.do(e.owner, "viewer,creator", "POST", base, audioBody("vi", "dub", mib)), &a)
	decode(t, e.do(e.owner, "viewer,creator", "POST", base, audioBody("en", "dub", mib)), &b)

	w := e.do(e.owner, "viewer,creator", "DELETE", base+"/"+a.TrackID, "")
	check(t, spec, "DELETE", pathTrack, w)
	if w.Code != 204 || e.audio.tracks[uuid.MustParse(a.TrackID)] != nil {
		t.Fatalf("abort: %d %s", w.Code, w.Body)
	}

	e.storage.objectSize = mib - 1
	w = e.do(e.owner, "viewer,creator", "POST", base+"/"+b.TrackID+"/complete", partsBody(1, "e"))
	check(t, spec, "POST", pathComplete, w)
	if w.Code != 400 || problemCode(t, w) != "SIZE_MISMATCH" {
		t.Fatalf("mismatch: %d %s", w.Code, w.Body)
	}
	tr := e.audio.tracks[uuid.MustParse(b.TrackID)]
	if tr.Status != domain.StatusFailed || tr.Error != "SIZE_MISMATCH" || len(e.audio.events) != 0 {
		t.Fatalf("track = %+v events=%d", tr, len(e.audio.events))
	}
	if got := e.storage.deleted; len(got) != 1 || got[0] != tr.RawKey {
		t.Errorf("deleted = %v", got)
	}
	w = e.do(e.owner, "viewer,creator", "POST", base+"/"+b.TrackID+"/complete", partsBody(1, "e"))
	if w.Code != 409 || problemCode(t, w) != "INVALID_STATE" {
		t.Fatalf("complete failed track: %d %s", w.Code, w.Body)
	}
}
