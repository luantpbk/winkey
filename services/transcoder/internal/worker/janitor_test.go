package worker

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/luantpbk/winkey/services/transcoder/internal/testutil"
)

const (
	vid   = "0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c0d"
	owner = "0192f5e0-0000-7000-8000-000000000001"
)

func goodEvent() deletedEvent {
	return deletedEvent{
		VideoID: vid, OwnerID: owner,
		RawBucket: "winkey-raw", RawKey: owner + "/" + vid + "/source",
		MediaBucket: "winkey-media", MediaPrefix: "v/" + vid + "/",
	}
}

func newJanitor(objs *testutil.MemObjects) *Janitor {
	return &Janitor{Objects: objs, MediaBucket: "winkey-media", RawBucket: "winkey-raw",
		Log: slog.New(slog.NewJSONHandler(io.Discard, nil))}
}

func TestValidateAcceptsLayout(t *testing.T) {
	if err := newJanitor(nil).Validate(goodEvent()); err != nil {
		t.Fatal(err)
	}
}

func TestValidateRefusesEventsThatCouldDeleteOtherThings(t *testing.T) {
	mutate := map[string]func(*deletedEvent){
		"prefix is everything":    func(e *deletedEvent) { e.MediaPrefix = "v/" },
		"empty prefix":            func(e *deletedEvent) { e.MediaPrefix = "" },
		"other video's prefix":    func(e *deletedEvent) { e.MediaPrefix = "v/0192f5e4-7c1a-7b3e-9d2a-000000000000/" },
		"prefix without slash":    func(e *deletedEvent) { e.MediaPrefix = "v/" + vid },
		"raw key of other owner":  func(e *deletedEvent) { e.RawKey = "someone-else/" + vid + "/source" },
		"raw key is a wildcard":   func(e *deletedEvent) { e.RawKey = "" },
		"unexpected media bucket": func(e *deletedEvent) { e.MediaBucket = "winkey-backups" },
		"unexpected raw bucket":   func(e *deletedEvent) { e.RawBucket = "winkey-backups" },
		"video id not a uuid":     func(e *deletedEvent) { e.VideoID = "../.." },
		"upper-case uuid":         func(e *deletedEvent) { e.VideoID = "0192F5E4-7C1A-7B3E-9D2A-5F6E7A8B9C0D" },
	}
	for name, m := range mutate {
		ev := goodEvent()
		m(&ev)
		if err := newJanitor(nil).Validate(ev); err == nil {
			t.Errorf("%s: event accepted", name)
		}
	}
}

func TestPurgeRemovesAllAttemptsAndRawOnly(t *testing.T) {
	objs := testutil.NewMemObjects()
	for _, k := range []string{
		"v/" + vid + "/a1/hls/master.m3u8", "v/" + vid + "/a2/thumb/poster.jpg",
		"v/0192f5e4-7c1a-7b3e-9d2a-000000000000/a1/hls/master.m3u8", // another video: must survive
	} {
		objs.Put("winkey-media", k, []byte("x"))
	}
	objs.Put("winkey-raw", owner+"/"+vid+"/source", []byte("raw"))
	objs.Put("winkey-raw", owner+"/other/source", []byte("raw"))

	if err := newJanitor(objs).Purge(context.Background(), goodEvent()); err != nil {
		t.Fatal(err)
	}
	if got := objs.Keys("winkey-media"); len(got) != 1 || got[0] != "v/0192f5e4-7c1a-7b3e-9d2a-000000000000/a1/hls/master.m3u8" {
		t.Errorf("media: %v", got)
	}
	if got := objs.Keys("winkey-raw"); len(got) != 1 || got[0] != owner+"/other/source" {
		t.Errorf("raw: %v", got)
	}
	// Idempotent: purging again is fine.
	if err := newJanitor(objs).Purge(context.Background(), goodEvent()); err != nil {
		t.Fatal(err)
	}
}

func TestCleanScratchOnlyRemovesJobDirs(t *testing.T) {
	dir := t.TempDir()
	mk := func(name string) { _ = os.MkdirAll(filepath.Join(dir, name), 0o755) }
	mk(vid + "-a1")
	mk(vid + "-a12")
	mk("keep-me")
	_ = os.WriteFile(filepath.Join(dir, vid+"-a3"), []byte("a file, not a job dir"), 0o644)

	CleanScratch(dir, slog.New(slog.NewJSONHandler(io.Discard, nil)))

	var left []string
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		left = append(left, e.Name())
	}
	if len(left) != 2 {
		t.Fatalf("left: %v", left)
	}
	CleanScratch(filepath.Join(dir, "missing"), slog.New(slog.NewJSONHandler(io.Discard, nil))) // must not panic
}
