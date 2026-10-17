package api

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/services/video/internal/domain"
)

// ---- memStore: audio tracks (MUX1) --------------------------------------------------------------------------

// tracksOf returns every track of the video; the video record's AudioTracks mirrors the READY ones, as
// GetVideo reads them.
func (s *memStore) tracksOf(id uuid.UUID) []domain.AudioTrack {
	if s.audio == nil {
		s.audio = map[uuid.UUID][]domain.AudioTrack{}
	}
	return s.audio[id]
}

func sortTracks(ts []domain.AudioTrack) {
	sort.Slice(ts, func(i, j int) bool {
		if ts[i].Lang != ts[j].Lang {
			return ts[i].Lang < ts[j].Lang
		}
		return ts[i].Kind < ts[j].Kind
	})
}

func readyOf(ts []domain.AudioTrack) []domain.AudioTrack {
	out := []domain.AudioTrack{}
	for _, t := range ts {
		if t.Status == domain.StatusReady {
			out = append(out, t)
		}
	}
	return out
}

// addTrack is the test's stand-in for upload-svc + transcoder.
func (s *memStore) addTrack(videoID uuid.UUID, t domain.AudioTrack) domain.AudioTrack {
	s.mu.Lock()
	defer s.mu.Unlock()
	if t.ID == uuid.Nil {
		t.ID = ids.New()
	}
	if t.Status == domain.StatusReady && t.PlaylistKey == "" {
		t.PlaylistKey = "v/" + videoID.String() + "/a2/audio/" + t.ID.String() + "/index.m3u8"
	}
	t.UpdatedAt = time.Date(2026, 10, 14, 8, 0, 0, 0, time.UTC)
	ts := append(s.tracksOf(videoID), t)
	sortTracks(ts)
	s.audio[videoID] = ts
	v := s.videos[videoID]
	v.AudioTracks = readyOf(ts)
	s.videos[videoID] = v
	return t
}

func (s *memStore) ListAudioTracks(_ context.Context, id uuid.UUID) ([]domain.AudioTrack, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]domain.AudioTrack{}, s.tracksOf(id)...), nil
}

func (s *memStore) changeAudio(ctx context.Context, videoID, trackID uuid.UUID, rewrite domain.MasterRewrite,
	change func([]domain.AudioTrack, int) ([]domain.AudioTrack, domain.AudioTrack, error)) (domain.AudioTrack, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.videos[videoID]
	if !ok {
		return domain.AudioTrack{}, domain.ErrNotFound
	}
	ts := append([]domain.AudioTrack{}, s.tracksOf(videoID)...)
	i := slices.IndexFunc(ts, func(t domain.AudioTrack) bool { return t.ID == trackID })
	if i < 0 {
		return domain.AudioTrack{}, domain.ErrNotFound
	}
	before := readyOf(ts)
	ts, res, err := change(ts, i)
	if err != nil {
		return domain.AudioTrack{}, err
	}
	after := readyOf(ts)
	if v.HLSMasterKey != nil && (len(before) > 0 || len(after) > 0) {
		newKey, err := rewrite(ctx, videoID, *v.HLSMasterKey, after)
		if err != nil {
			return domain.AudioTrack{}, err // rolled back: nothing changes
		}
		v.HLSMasterKey = &newKey
	}
	s.audio[videoID] = ts
	v.AudioTracks = after
	s.videos[videoID] = v
	return res, nil
}

func (s *memStore) UpdateAudioTrack(ctx context.Context, videoID, trackID uuid.UUID, u domain.AudioTrackUpdate, rewrite domain.MasterRewrite) (domain.AudioTrack, error) {
	return s.changeAudio(ctx, videoID, trackID, rewrite, func(ts []domain.AudioTrack, i int) ([]domain.AudioTrack, domain.AudioTrack, error) {
		if u.MakeDefault {
			for j := range ts {
				ts[j].IsDefault = false
			}
			ts[i].IsDefault = true
		}
		if u.ClearDefault {
			ts[i].IsDefault = false
		}
		if u.Label != nil {
			ts[i].Label = *u.Label
		}
		return ts, ts[i], nil
	})
}

func (s *memStore) DeleteAudioTrack(ctx context.Context, videoID, trackID uuid.UUID, rewrite domain.MasterRewrite) (domain.AudioTrack, error) {
	return s.changeAudio(ctx, videoID, trackID, rewrite, func(ts []domain.AudioTrack, i int) ([]domain.AudioTrack, domain.AudioTrack, error) {
		if ts[i].Status == domain.StatusUploading {
			return nil, domain.AudioTrack{}, domain.ErrAudioTrackUploading
		}
		cur := ts[i]
		return slices.Delete(ts, i, i+1), cur, nil
	})
}

// ---- tests -----------------------------------------------------------------------------------------------

const plainMaster = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-STREAM-INF:BANDWIDTH=5300000,RESOLUTION=1920x1080,CODECS=\"avc1.640028,mp4a.40.2\"\n1080p/index.m3u8\n"

// audioVideo is a READY video whose master object exists in the bucket.
func (e *env) audioVideo(owner *who) domain.Video {
	v := e.video(owner)
	_ = e.objs.Put(context.Background(), "winkey-media", *v.HLSMasterKey, []byte(plainMaster), "application/vnd.apple.mpegurl", cacheImmutable)
	return v
}

func audioPath(v domain.Video, rest string) string {
	return "/v1/videos/" + v.ID.String() + "/audio-tracks" + rest
}

func (e *env) master(v domain.Video) (string, string) {
	cur, _ := e.store.GetVideo(context.Background(), v.ID)
	o, _ := e.objs.Get("winkey-media", *cur.HLSMasterKey)
	return *cur.HLSMasterKey, string(o.Data)
}

type audioListOut struct {
	Items []audioTrackJSON `json:"items"`
}

func TestListAudioTracksOwnerOnly(t *testing.T) {
	e := newEnv(t, false)
	v := e.audioVideo(alice)
	e.store.addTrack(v.ID, domain.AudioTrack{Lang: "vi", Label: "Thuyết minh", Kind: "voiceover", Status: domain.StatusReady, IsDefault: true})
	e.store.addTrack(v.ID, domain.AudioTrack{Lang: "en", Label: "English", Kind: "dub", Status: domain.StatusFailed, Error: "AUDIO_DURATION_MISMATCH"})
	e.store.addTrack(v.ID, domain.AudioTrack{Lang: "en", Label: "Commentary", Kind: "commentary", Status: domain.StatusUploading})

	w := e.req(alice, "GET", audioPath(v, ""), "")
	if w.Code != http.StatusOK || w.Header().Get("Cache-Control") != cachePrivate {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	got := decode[audioListOut](t, w)
	var order []string
	for _, it := range got.Items {
		order = append(order, it.Lang+"/"+it.Kind+"/"+it.Status)
	}
	if strings.Join(order, " ") != "en/commentary/UPLOADING en/dub/FAILED vi/voiceover/READY" {
		t.Fatalf("order %v", order)
	}
	if got.Items[1].Error == nil || *got.Items[1].Error != "AUDIO_DURATION_MISMATCH" || got.Items[0].Error != nil {
		t.Errorf("errors: %+v", got.Items)
	}

	if w := e.req(bob, "GET", audioPath(v, ""), ""); w.Code != http.StatusForbidden {
		t.Errorf("other user: %d", w.Code)
	}
	if w := e.req(alice, "GET", "/v1/videos/"+ids.NewString()+"/audio-tracks", ""); w.Code != http.StatusNotFound {
		t.Errorf("unknown video: %d", w.Code)
	}
	if w := e.req(nil, "GET", audioPath(v, ""), ""); w.Code != http.StatusUnauthorized {
		t.Errorf("anonymous: %d", w.Code)
	}
}

func TestPlaybackAudioTracks(t *testing.T) {
	e := newEnv(t, false)
	v := e.audioVideo(alice)

	type pbOut struct {
		Playback struct {
			AudioTracks []playbackAudioJSON `json:"audio_tracks"`
		} `json:"playback"`
	}
	get := func() []playbackAudioJSON {
		w := e.req(nil, "GET", "/v1/videos/"+v.ID.String(), "")
		if w.Code != http.StatusOK {
			t.Fatalf("%d %s", w.Code, w.Body)
		}
		return decode[pbOut](t, w).Playback.AudioTracks
	}
	if got := get(); got == nil || len(got) != 0 {
		t.Fatalf("no tracks: %#v, want []", got)
	}

	e.store.addTrack(v.ID, domain.AudioTrack{Lang: "vi", Label: "Thuyết minh", Kind: "voiceover", Status: domain.StatusReady})
	e.store.addTrack(v.ID, domain.AudioTrack{Lang: "en", Label: "English", Kind: "dub", Status: domain.StatusProcessing})
	got := get()
	if len(got) != 2 || got[0].ID != v.ID.String() || got[0].Lang != "und" || got[0].Kind != "original" || !got[0].IsDefault ||
		got[1].Lang != "vi" || got[1].IsDefault {
		t.Fatalf("playback audio = %+v", got)
	}
}

func TestUpdateAudioTrackRewritesMaster(t *testing.T) {
	e := newEnv(t, true)
	v := e.audioVideo(alice)
	vi := e.store.addTrack(v.ID, domain.AudioTrack{Lang: "vi", Label: "Thuyết minh", Kind: "voiceover", Status: domain.StatusReady})
	en := e.store.addTrack(v.ID, domain.AudioTrack{Lang: "en", Label: "English", Kind: "dub", Status: domain.StatusReady, IsDefault: true})
	oldKey := *v.HLSMasterKey

	w := e.req(alice, "PATCH", audioPath(v, "/"+vi.ID.String()), `{"label":"  Lồng tiếng ","is_default":true}`)
	if w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	got := decode[audioTrackJSON](t, w)
	if got.Label != "Lồng tiếng" || !got.IsDefault || got.Status != domain.StatusReady {
		t.Fatalf("track = %+v", got)
	}
	key, body := e.master(v)
	if key == oldKey || !strings.HasPrefix(key, "v/"+v.ID.String()+"/a1/hls/master-") {
		t.Fatalf("master key %q (old %q)", key, oldKey)
	}
	if o, _ := e.objs.Get("winkey-media", key); o.ContentType != "application/vnd.apple.mpegurl" || o.CacheControl != cacheImmutable {
		t.Errorf("master object headers %q %q", o.ContentType, o.CacheControl)
	}
	if !strings.Contains(body, `LANGUAGE="vi",NAME="Lồng tiếng",DEFAULT=YES`) ||
		!strings.Contains(body, `LANGUAGE="en",NAME="English",DEFAULT=NO`) ||
		!strings.Contains(body, `URI="../../a2/audio/`+en.ID.String()+`/index.m3u8"`) ||
		!strings.Contains(body, `,AUDIO="aud"`) {
		t.Fatalf("master:\n%s", body)
	}
	if old, _ := e.objs.Get("winkey-media", oldKey); string(old.Data) != plainMaster {
		t.Error("the old master object must stay as it was (it is cached as immutable)")
	}
	if e.cache.inval == 0 {
		t.Error("cache not invalidated")
	}
}

// DEF1: is_default false clears the track's default, so the video's own audio is the default again.
func TestUpdateAudioTrackClearDefault(t *testing.T) {
	e := newEnv(t, true)
	v := e.audioVideo(alice)
	vi := e.store.addTrack(v.ID, domain.AudioTrack{Lang: "vi", Label: "Thuyết minh", Kind: "voiceover", Status: domain.StatusReady, IsDefault: true})

	w := e.req(alice, "PATCH", audioPath(v, "/"+vi.ID.String()), `{"is_default":false}`)
	if w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if got := decode[audioTrackJSON](t, w); got.IsDefault || got.Label != "Thuyết minh" {
		t.Fatalf("track = %+v", got)
	}
	_, body := e.master(v)
	var media []string
	for _, l := range strings.Split(body, "\n") {
		if strings.HasPrefix(l, "#EXT-X-MEDIA:") {
			media = append(media, l)
		}
	}
	if len(media) != 2 || !strings.Contains(media[0], "DEFAULT=YES") || strings.Contains(media[0], `LANGUAGE="vi"`) ||
		!strings.Contains(media[1], `LANGUAGE="vi",NAME="Thuyết minh",DEFAULT=NO`) {
		t.Fatalf("master:\n%s", body)
	}
}

func TestUpdateAudioTrackValidation(t *testing.T) {
	e := newEnv(t, false)
	v := e.audioVideo(alice)
	tr := e.store.addTrack(v.ID, domain.AudioTrack{Lang: "vi", Label: "x", Kind: "dub", Status: domain.StatusReady})
	p := audioPath(v, "/"+tr.ID.String())
	for name, body := range map[string]string{
		"empty":         `{}`,
		"blank label":   `{"label":"   "}`,
		"long label":    `{"label":"` + strings.Repeat("a", 51) + `"}`,
		"unknown field": `{"label":"x","lang":"en"}`,
	} {
		if w := e.req(alice, "PATCH", p, body); w.Code != http.StatusBadRequest {
			t.Errorf("%s: %d %s", name, w.Code, w.Body)
		}
	}
	if w := e.req(bob, "PATCH", p, `{"label":"x"}`); w.Code != http.StatusForbidden {
		t.Errorf("other user: %d", w.Code)
	}
	if w := e.req(alice, "PATCH", audioPath(v, "/"+ids.NewString()), `{"label":"x"}`); w.Code != http.StatusNotFound {
		t.Errorf("unknown track: %d", w.Code)
	}
	if w := e.req(alice, "PATCH", audioPath(v, "/nope"), `{"label":"x"}`); w.Code != http.StatusNotFound {
		t.Errorf("malformed track id: %d", w.Code)
	}
	other := e.audioVideo(alice)
	if w := e.req(alice, "PATCH", audioPath(other, "/"+tr.ID.String()), `{"label":"x"}`); w.Code != http.StatusNotFound {
		t.Errorf("track of another video: %d", w.Code)
	}
}

func TestUpdateAudioTrackMasterFailureChangesNothing(t *testing.T) {
	e := newEnv(t, false)
	v := e.audioVideo(alice)
	tr := e.store.addTrack(v.ID, domain.AudioTrack{Lang: "vi", Label: "x", Kind: "dub", Status: domain.StatusReady})
	e.objs.ReadErr = errors.New("garage down")
	if w := e.reqNoContract(alice, "PATCH", audioPath(v, "/"+tr.ID.String()), `{"label":"y"}`); w.Code != http.StatusInternalServerError {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	ts, _ := e.store.ListAudioTracks(context.Background(), v.ID)
	if ts[0].Label != "x" {
		t.Error("the label changed although the master could not be rewritten")
	}
}

func TestDeleteAudioTrack(t *testing.T) {
	e := newEnv(t, false)
	v := e.audioVideo(alice)
	vi := e.store.addTrack(v.ID, domain.AudioTrack{Lang: "vi", Label: "x", Kind: "dub", Status: domain.StatusReady})
	up := e.store.addTrack(v.ID, domain.AudioTrack{Lang: "en", Label: "y", Kind: "dub", Status: domain.StatusUploading})
	_ = e.objs.Put(context.Background(), "winkey-media", vi.PlaylistKey, []byte("#EXTM3U\n"), "application/vnd.apple.mpegurl", cacheImmutable)
	_ = e.objs.Put(context.Background(), "winkey-media", strings.TrimSuffix(vi.PlaylistKey, "index.m3u8")+"seg_00001.m4s", []byte("x"), "video/iso.segment", cacheImmutable)

	if w := e.req(alice, "DELETE", audioPath(v, "/"+up.ID.String()), ""); w.Code != http.StatusConflict {
		t.Fatalf("uploading: %d %s", w.Code, w.Body)
	}
	if w := e.req(bob, "DELETE", audioPath(v, "/"+vi.ID.String()), ""); w.Code != http.StatusForbidden {
		t.Fatalf("other user: %d", w.Code)
	}
	if w := e.req(alice, "DELETE", audioPath(v, "/"+vi.ID.String()), ""); w.Code != http.StatusNoContent {
		t.Fatalf("delete: %d %s", w.Code, w.Body)
	}
	// The last READY track is gone: the new master has no audio group again.
	_, body := e.master(v)
	if body != plainMaster {
		t.Fatalf("master:\n%s", body)
	}
	if keys := e.objs.Keys("winkey-media", "v/"+v.ID.String()+"/a2/audio/"); len(keys) != 0 {
		t.Errorf("track objects left: %v", keys)
	}
	if w := e.req(alice, "DELETE", audioPath(v, "/"+vi.ID.String()), ""); w.Code != http.StatusNotFound {
		t.Errorf("second delete: %d", w.Code)
	}
}

func TestTrackPrefixStaysInsideTheVideo(t *testing.T) {
	id := ids.New()
	for key, want := range map[string]string{
		"v/" + id.String() + "/a2/audio/t/index.m3u8": "v/" + id.String() + "/a2/audio/t/",
		"":                                 "",
		"v/" + id.String() + "/index.m3u8": "", // the video's root: never
		"v/" + ids.NewString() + "/a2/audio/t/index.m3u8": "",
		"v/" + id.String() + "/../x/a/b/index.m3u8":       "",
	} {
		if got := trackPrefix(id, key); got != want {
			t.Errorf("%q -> %q, want %q", key, got, want)
		}
	}
}
