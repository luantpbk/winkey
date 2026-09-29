// Package testutil seeds PostgreSQL (real migrations, via libs/go/testkit) for
// the store and integration tests.
package testutil

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/luantpbk/winkey/libs/go/ids"
)

// User is a row of auth.users.
type User struct {
	ID     uuid.UUID
	Handle string
	Name   string
	Avatar *string
	Status string // ACTIVE (default), SUSPENDED, DELETED
}

// SeedUser inserts an auth.users row (the only auth data video-svc reads is the
// auth.public_profiles view over it).
func SeedUser(t testing.TB, pool *pgxpool.Pool, handle string, avatar *string, status string) User {
	t.Helper()
	if status == "" {
		status = "ACTIVE"
	}
	u := User{ID: ids.New(), Handle: handle, Name: "Name of " + handle, Avatar: avatar, Status: status}
	// Migration 000006: a SUSPENDED user must carry a reason.
	var reason *string
	if status == "SUSPENDED" {
		r := "seeded for tests"
		reason = &r
	}
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO auth.users (id, email, handle, display_name, avatar_key, status, suspension_reason)
		VALUES ($1, $2, $3, $4, $5, $6::auth.user_status, $7)`,
		u.ID, handle+"@example.test", handle, u.Name, avatar, status, reason); err != nil {
		t.Fatalf("seed user %s: %v", handle, err)
	}
	return u
}

// Video describes a media.videos row to insert. Zero values give a READY,
// PUBLIC video published at Published (default: now).
type Video struct {
	ID          uuid.UUID
	Owner       uuid.UUID
	Title       string
	Status      string // default READY
	Visibility  string // default PUBLIC
	Published   time.Time
	Created     time.Time
	Renditions  []string // names, e.g. "1080p"; default 3 for READY
	Error       string
	ViewCount   int64
	RawKey      string
	Attempts    []float32 // progress of transcode_jobs attempts 1..n (the last one is the latest)
	NoThumbnail bool
}

// SeedVideo inserts the video, its renditions (when READY) and jobs.
func SeedVideo(t testing.TB, pool *pgxpool.Pool, v Video) Video {
	t.Helper()
	ctx := context.Background()
	if v.ID == uuid.Nil {
		v.ID = ids.New()
	}
	if v.Title == "" {
		v.Title = "Video " + v.ID.String()[24:]
	}
	if v.Status == "" {
		v.Status = "READY"
	}
	if v.Visibility == "" {
		v.Visibility = "PUBLIC"
	}
	if v.Published.IsZero() {
		v.Published = time.Now().UTC().Truncate(time.Microsecond)
	}
	if v.Created.IsZero() {
		v.Created = v.Published.Add(-time.Hour)
	}
	if v.RawKey == "" {
		v.RawKey = v.Owner.String() + "/" + v.ID.String() + "/source"
	}
	ready := v.Status == "READY"

	var master, thumb *string
	var dur, w, h *int
	var pub *time.Time
	if ready {
		m, th := fmt.Sprintf("v/%s/a1/hls/master.m3u8", v.ID), fmt.Sprintf("v/%s/a1/thumb/poster.jpg", v.ID)
		master, thumb = &m, &th
		d, ww, hh := 61000, 1920, 1080
		dur, w, h, pub = &d, &ww, &hh, &v.Published
		if v.NoThumbnail {
			t.Fatal("READY videos always have a thumbnail")
		}
	}
	var errMsg *string
	if v.Error != "" {
		errMsg = &v.Error
	}
	// Insert as UPLOADING then move to the target status (the state machine trigger
	// only allows valid transitions; READY needs the output columns set together).
	if _, err := pool.Exec(ctx, `
		INSERT INTO media.videos (id, owner_id, title, description, visibility, status, raw_bucket, raw_key,
		                          content_type, size_bytes, duration_ms, width, height, hls_master_key,
		                          thumbnail_key, error, view_count, published_at, created_at)
		VALUES ($1, $2, $3, 'about it', $4::media.visibility, 'UPLOADING', 'winkey-raw', $5,
		        'video/mp4', 1000, NULL, NULL, NULL, NULL, NULL, $6, $7, NULL, $8)`,
		v.ID, v.Owner, v.Title, v.Visibility, v.RawKey, errMsg, v.ViewCount, v.Created); err != nil {
		t.Fatalf("seed video: %v", err)
	}
	switch v.Status {
	case "UPLOADING":
	case "UPLOADED", "PROCESSING", "FAILED", "READY":
		steps := map[string][]string{
			"UPLOADED":   {"UPLOADED"},
			"PROCESSING": {"UPLOADED", "PROCESSING"},
			"FAILED":     {"UPLOADED", "FAILED"},
			"READY":      {"UPLOADED", "PROCESSING"},
		}[v.Status]
		for _, s := range steps {
			if _, err := pool.Exec(ctx, `UPDATE media.videos SET status = $2::media.video_status WHERE id = $1`, v.ID, s); err != nil {
				t.Fatalf("seed video status %s: %v", s, err)
			}
		}
		if ready {
			if _, err := pool.Exec(ctx, `
				UPDATE media.videos SET status = 'READY', duration_ms = $2, width = $3, height = $4,
				       hls_master_key = $5, thumbnail_key = $6, published_at = $7 WHERE id = $1`,
				v.ID, *dur, *w, *h, *master, *thumb, *pub); err != nil {
				t.Fatalf("seed video ready: %v", err)
			}
		}
	default:
		t.Fatalf("unknown status %s", v.Status)
	}

	if ready {
		names := v.Renditions
		if names == nil {
			names = []string{"1080p", "720p", "480p"}
		}
		dims := map[string][3]int{"1080p": {1920, 1080, 5000}, "720p": {1280, 720, 2800}, "480p": {854, 480, 1400}, "360p": {640, 360, 800}}
		for _, n := range names {
			d := dims[n]
			if _, err := pool.Exec(ctx, `
				INSERT INTO media.video_renditions (video_id, name, width, height, bitrate_kbps, playlist_key)
				VALUES ($1, $2, $3, $4, $5, $6)`,
				v.ID, n, d[0], d[1], d[2], fmt.Sprintf("v/%s/a1/hls/%s/index.m3u8", v.ID, n)); err != nil {
				t.Fatalf("seed rendition: %v", err)
			}
		}
	}
	for i, p := range v.Attempts {
		status := "FAILED"
		if i == len(v.Attempts)-1 {
			status = "RUNNING"
			if ready {
				status = "SUCCEEDED"
			}
			if v.Status == "FAILED" {
				status = "FAILED"
			}
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO media.transcode_jobs (id, video_id, attempt, status, progress)
			VALUES ($1, $2, $3, $4::media.job_status, $5)`, ids.New(), v.ID, i+1, status, p); err != nil {
			t.Fatalf("seed job: %v", err)
		}
	}
	return v
}
