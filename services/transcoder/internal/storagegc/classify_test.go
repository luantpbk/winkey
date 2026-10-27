package storagegc

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

var (
	now    = time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	old    = now.Add(-72 * time.Hour)
	minAge = 48 * time.Hour

	owner   = uuid.MustParse("0192f5e4-7c1a-7b3e-9d2a-00000000aaaa")
	ready   = uuid.MustParse("0192f5e4-7c1a-7b3e-9d2a-000000000001")
	busy    = uuid.MustParse("0192f5e4-7c1a-7b3e-9d2a-000000000002")
	gone    = uuid.MustParse("0192f5e4-7c1a-7b3e-9d2a-000000000003")
	legacy  = uuid.MustParse("0192f5e4-7c1a-7b3e-9d2a-000000000004")
	trackOK = uuid.MustParse("0192f5e4-7c1a-7b3e-9d2a-0000000000a1")
	trackP  = uuid.MustParse("0192f5e4-7c1a-7b3e-9d2a-0000000000a2")
	trackX  = uuid.MustParse("0192f5e4-7c1a-7b3e-9d2a-0000000000a3")
)

func snapshot() *Snapshot {
	return NewSnapshot([]Video{
		{ID: ready, Owner: owner, Status: "READY", MasterKey: "v/" + ready.String() + "/a3/hls/master.m3u8",
			AV1MasterKey: "v/" + ready.String() + "/av1/run2/master.m3u8"},
		{ID: busy, Owner: owner, Status: "PROCESSING", MasterKey: "v/" + busy.String() + "/a1/hls/master.m3u8"},
		{ID: legacy, Owner: owner, Status: "READY", MasterKey: "v/" + legacy.String() + "/hls/master.m3u8"},
	}, map[uuid.UUID]map[uuid.UUID]string{ready: {trackOK: "READY", trackP: "PROCESSING"}})
}

func TestClassifyMedia(t *testing.T) {
	s := snapshot()
	r, b, g := "v/"+ready.String()+"/", "v/"+busy.String()+"/", "v/"+gone.String()+"/"
	cases := map[string]Category{
		r + "a3/hls/1080p/seg_00001.m4s":           MediaCurrent,
		r + "a3/storyboard/storyboard.vtt":         MediaCurrent,
		r + "a2/hls/1080p/seg_00001.m4s":           MediaOldAttempt,
		r + "a1/thumb/poster.jpg":                  MediaOldAttempt,
		r + "av1/run2/1080p/seg_00001.m4s":         MediaAV1Current,
		r + "av1/run1/1080p/seg_00001.m4s":         MediaOldAV1,
		r + "audio/" + trackOK.String() + "/a.m4s": MediaAudio,
		r + "audio/" + trackX.String() + "/a.m4s":  MediaOrphanAudio,
		r + "subtitles/vi.vtt":                     MediaCurrent,
		b + "a1/hls/master.m3u8":                   MediaInFlight, // re-encoding: every attempt is kept
		b + "a2/hls/master.m3u8":                   MediaInFlight,
		g + "a1/hls/master.m3u8":                   MediaOrphanVideo,
		"v/" + legacy.String() + "/a1/hls/x.m4s":   MediaInFlight, // master outside an attempt dir: keep all
		"v/not-a-uuid/a1/x":                        Unknown,
		"static/manifest.json":                     Unknown,
		"v/" + ready.String():                      Unknown,
	}
	for key, want := range cases {
		if got := s.ClassifyMedia(key, old, now, minAge); got != want {
			t.Errorf("%s: %s, want %s", key, got, want)
		}
	}
	// The age guard wins over every verdict, even for an orphan.
	if got := s.ClassifyMedia(g+"a1/hls/master.m3u8", now.Add(-time.Hour), now, minAge); got != Recent {
		t.Errorf("young orphan: %s", got)
	}
}

func TestClassifyRaw(t *testing.T) {
	s := snapshot()
	o := owner.String() + "/"
	cases := map[string]Category{
		o + ready.String() + "/source":                                       RawSource,
		o + gone.String() + "/source":                                        RawOrphanVideo,
		"0192f5e4-7c1a-7b3e-9d2a-00000000bbbb/" + ready.String() + "/source": RawOrphanVideo, // wrong owner
		o + ready.String() + "/audio/" + trackOK.String() + "/source":        RawAudioProcessed,
		o + ready.String() + "/audio/" + trackP.String() + "/source":         RawAudioLive,
		o + ready.String() + "/audio/" + trackX.String() + "/source":         RawOrphanAudio,
		o + gone.String() + "/audio/" + trackX.String() + "/source":          RawOrphanVideo,
		o + ready.String() + "/other":                                        Unknown,
		"loose-file":                                                         Unknown,
	}
	for key, want := range cases {
		if got := s.ClassifyRaw(key, old, now, minAge); got != want {
			t.Errorf("%s: %s, want %s", key, got, want)
		}
	}
	if got := s.ClassifyRaw(o+gone.String()+"/source", now.Add(-time.Hour), now, minAge); got != Recent {
		t.Errorf("young orphan raw: %s", got)
	}
}

func TestOnlyGarbageIsDeletable(t *testing.T) {
	for _, c := range []Category{MediaCurrent, MediaAV1Current, MediaAudio, MediaInFlight, RawSource, RawAudioLive, Recent, Unknown} {
		if IsDeletable(c) {
			t.Errorf("%s must never be deletable", c)
		}
	}
	for _, c := range Deletable {
		if !IsDeletable(c) {
			t.Errorf("%s", c)
		}
	}
}

func TestSelectedOnlyReturnsChosenGarbage(t *testing.T) {
	r := &Report{ByCat: map[Category]Total{}, ByBucket: map[string]Total{}}
	r.add(Object{Bucket: "m", Key: "live", Size: 1, Category: MediaCurrent})
	r.add(Object{Bucket: "m", Key: "old", Size: 2, Category: MediaOldAttempt})
	r.add(Object{Bucket: "r", Key: "orphan", Size: 3, Category: RawOrphanVideo})
	if got := r.Selected(map[Category]bool{MediaCurrent: true, RawSource: true}); len(got) != 0 {
		t.Fatalf("live categories selected: %v", got)
	}
	got := r.Selected(map[Category]bool{MediaOldAttempt: true})
	if len(got) != 1 || got[0].Key != "old" {
		t.Fatalf("selected %v", got)
	}
	if r.ByCat[MediaOldAttempt].Bytes != 2 || r.ByBucket["m"].Count != 2 {
		t.Fatalf("totals %v %v", r.ByCat, r.ByBucket)
	}
}

func TestClassifyImages(t *testing.T) {
	now := time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)
	old := now.Add(-72 * time.Hour)
	owner := uuid.MustParse("0192f5e0-0000-7000-8000-000000000001")
	mk := func(n int, purpose, status string) Image {
		id := uuid.MustParse("019a2f10-0000-7000-8000-00000000000" + string(rune('0'+n)))
		return Image{ID: id, Owner: owner, Purpose: purpose, Status: status,
			ImageKey: "i/" + owner.String() + "/" + id.String() + "/image.webp"}
	}
	avatarInUse, avatarOld := mk(1, "AVATAR", "READY"), mk(2, "AVATAR", "READY")
	post, failed, processing := mk(3, "POST", "READY"), mk(4, "POST", "FAILED"), mk(5, "BANNER", "PROCESSING")
	gone := uuid.MustParse("019a2f10-0000-7000-8000-000000000009")
	s := NewSnapshot(nil, nil)
	s.SetImages([]Image{avatarInUse, avatarOld, post, failed, processing}, map[string]bool{avatarInUse.ImageKey: true})

	media := func(i uuid.UUID, file string) string { return "i/" + owner.String() + "/" + i.String() + "/" + file }
	raw := func(i uuid.UUID) string { return owner.String() + "/images/" + i.String() }
	cases := map[string]struct {
		got, want Category
	}{
		"avatar in use":      {s.ClassifyMedia(media(avatarInUse.ID, "thumb.webp"), old, now, 48*time.Hour), MediaImage},
		"replaced avatar":    {s.ClassifyMedia(media(avatarOld.ID, "image.webp"), old, now, 48*time.Hour), ImageUnreferenced},
		"post":               {s.ClassifyMedia(media(post.ID, "image.webp"), old, now, 48*time.Hour), MediaImage},
		"failed outputs":     {s.ClassifyMedia(media(failed.ID, "image.webp"), old, now, 48*time.Hour), MediaOrphanImage},
		"processing outputs": {s.ClassifyMedia(media(processing.ID, "image.webp"), old, now, 48*time.Hour), MediaInFlight},
		"no row":             {s.ClassifyMedia(media(gone, "image.webp"), old, now, 48*time.Hour), MediaOrphanImage},
		"recent replaced":    {s.ClassifyMedia(media(avatarOld.ID, "image.webp"), now.Add(-time.Hour), now, 48*time.Hour), Recent},
		"raw ready":          {s.ClassifyRaw(raw(post.ID), old, now, 48*time.Hour), RawImageProcessed},
		"raw failed":         {s.ClassifyRaw(raw(failed.ID), old, now, 48*time.Hour), RawImageProcessed},
		"raw processing":     {s.ClassifyRaw(raw(processing.ID), old, now, 48*time.Hour), RawImageLive},
		"raw no row":         {s.ClassifyRaw(raw(gone), old, now, 48*time.Hour), RawOrphanImage},
		"raw bad id":         {s.ClassifyRaw(owner.String()+"/images/nope", old, now, 48*time.Hour), Unknown},
		"media other owner":  {s.ClassifyMedia("i/"+uuid.NewString()+"/"+post.ID.String()+"/image.webp", old, now, 48*time.Hour), MediaOrphanImage},
	}
	for name, c := range cases {
		if c.got != c.want {
			t.Errorf("%s: got %s want %s", name, c.got, c.want)
		}
	}
	if id, ok := ImageID(media(post.ID, "image.webp")); !ok || id != post.ID {
		t.Fatal("ImageID")
	}
	for _, c := range []Category{MediaOrphanImage, ImageUnreferenced, RawImageProcessed, RawOrphanImage} {
		if !IsDeletable(c) {
			t.Errorf("%s must be deletable", c)
		}
	}
	for _, c := range []Category{MediaImage, RawImageLive} {
		if IsDeletable(c) {
			t.Errorf("%s must be kept", c)
		}
	}
}
