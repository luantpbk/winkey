package storagegc

import (
	"context"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Load reads the snapshot: every video row and every extra audio track.
func Load(ctx context.Context, pool *pgxpool.Pool) (*Snapshot, error) {
	rows, err := pool.Query(ctx, `SELECT id, owner_id, status::text, coalesce(hls_master_key, ''), coalesce(hls_av1_master_key, '') FROM media.videos`)
	if err != nil {
		return nil, fmt.Errorf("load videos: %w", err)
	}
	var videos []Video
	for rows.Next() {
		var v Video
		if err := rows.Scan(&v.ID, &v.Owner, &v.Status, &v.MasterKey, &v.AV1MasterKey); err != nil {
			rows.Close()
			return nil, err
		}
		videos = append(videos, v)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	tracks := map[uuid.UUID]map[uuid.UUID]string{}
	rows, err = pool.Query(ctx, `SELECT video_id, id, status FROM media.video_audio_tracks`)
	if err != nil {
		return nil, fmt.Errorf("load audio tracks: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var vid, tid uuid.UUID
		var status string
		if err := rows.Scan(&vid, &tid, &status); err != nil {
			return nil, err
		}
		if tracks[vid] == nil {
			tracks[vid] = map[uuid.UUID]string{}
		}
		tracks[vid][tid] = status
	}
	return NewSnapshot(videos, tracks), rows.Err()
}

// Object is one listed object and its verdict.
type Object struct {
	Bucket   string
	Key      string
	Size     int64
	Category Category
}

// Report aggregates the verdicts.
type Report struct {
	Objects  []Object
	ByCat    map[Category]Total
	ByBucket map[string]Total
	// PerVideo is the media bytes per video id (top consumers).
	PerVideo map[string]int64
	// StaleUploads are multipart uploads of the raw bucket older than the age guard that no UPLOADING row
	// references; they are billed as storage until aborted.
	StaleUploads []Upload
}

// Total is a count and a byte sum.
type Total struct {
	Count int
	Bytes int64
}

// Upload is an in-progress multipart upload.
type Upload struct {
	Key, UploadID string
	Initiated     time.Time
}

// Scan lists both buckets and classifies every object.
func Scan(ctx context.Context, c *s3.Client, snap *Snapshot, mediaBucket, rawBucket string, now time.Time, minAge time.Duration) (*Report, error) {
	r := &Report{ByCat: map[Category]Total{}, ByBucket: map[string]Total{}, PerVideo: map[string]int64{}}
	for _, b := range []struct {
		name     string
		classify func(string, time.Time, time.Time, time.Duration) Category
	}{{mediaBucket, snap.ClassifyMedia}, {rawBucket, snap.ClassifyRaw}} {
		p := s3.NewListObjectsV2Paginator(c, &s3.ListObjectsV2Input{Bucket: aws.String(b.name)})
		for p.HasMorePages() {
			page, err := p.NextPage(ctx)
			if err != nil {
				return nil, fmt.Errorf("list %s: %w", b.name, err)
			}
			for _, o := range page.Contents {
				key, size := aws.ToString(o.Key), aws.ToInt64(o.Size)
				cat := b.classify(key, aws.ToTime(o.LastModified), now, minAge)
				r.add(Object{Bucket: b.name, Key: key, Size: size, Category: cat})
				if b.name == mediaBucket && strings.HasPrefix(key, "v/") {
					if id, _, ok := strings.Cut(strings.TrimPrefix(key, "v/"), "/"); ok {
						r.PerVideo[id] += size
					}
				}
			}
		}
	}
	return r, nil
}

func (r *Report) add(o Object) {
	r.Objects = append(r.Objects, o)
	t := r.ByCat[o.Category]
	t.Count++
	t.Bytes += o.Size
	r.ByCat[o.Category] = t
	bt := r.ByBucket[o.Bucket]
	bt.Count++
	bt.Bytes += o.Size
	r.ByBucket[o.Bucket] = bt
}

// ScanUploads lists the multipart uploads of bucket older than minAge that no UPLOADING row references.
func ScanUploads(ctx context.Context, c *s3.Client, pool *pgxpool.Pool, bucket string, now time.Time, minAge time.Duration) ([]Upload, error) {
	live := map[string]bool{}
	rows, err := pool.Query(ctx, `
		SELECT s3_upload_id FROM media.videos WHERE s3_upload_id IS NOT NULL
		UNION ALL SELECT s3_upload_id FROM media.video_audio_tracks WHERE s3_upload_id IS NOT NULL`)
	if err != nil {
		return nil, fmt.Errorf("load upload ids: %w", err)
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		live[id] = true
	}
	rows.Close()
	var out []Upload
	in := &s3.ListMultipartUploadsInput{Bucket: aws.String(bucket)}
	for {
		page, err := c.ListMultipartUploads(ctx, in)
		if err != nil {
			return nil, fmt.Errorf("list multipart uploads: %w", err)
		}
		for _, u := range page.Uploads {
			id, at := aws.ToString(u.UploadId), aws.ToTime(u.Initiated)
			if !live[id] && now.Sub(at) >= minAge {
				out = append(out, Upload{Key: aws.ToString(u.Key), UploadID: id, Initiated: at})
			}
		}
		if !aws.ToBool(page.IsTruncated) {
			return out, nil
		}
		in.KeyMarker, in.UploadIdMarker = page.NextKeyMarker, page.NextUploadIdMarker
	}
}

// Print writes the human report.
func (r *Report) Print(w io.Writer, top int) {
	fmt.Fprintln(w, "== buckets")
	for _, b := range sortedKeys(r.ByBucket) {
		t := r.ByBucket[b]
		fmt.Fprintf(w, "%-22s %8d objects %12s\n", b, t.Count, human(t.Bytes))
	}
	fmt.Fprintln(w, "== categories (* = deletable with -apply)")
	cats := make([]Category, 0, len(r.ByCat))
	for c := range r.ByCat {
		cats = append(cats, c)
	}
	sort.Slice(cats, func(i, j int) bool { return r.ByCat[cats[i]].Bytes > r.ByCat[cats[j]].Bytes })
	var garbage int64
	for _, c := range cats {
		t := r.ByCat[c]
		mark := " "
		if IsDeletable(c) {
			mark = "*"
			garbage += t.Bytes
		}
		fmt.Fprintf(w, "%s %-22s %8d objects %12s\n", mark, c, t.Count, human(t.Bytes))
	}
	fmt.Fprintf(w, "deletable total: %s\n", human(garbage))
	fmt.Fprintf(w, "== stale multipart uploads (raw bucket): %d\n", len(r.StaleUploads))
	for _, u := range r.StaleUploads {
		fmt.Fprintf(w, "  %s  started %s\n", u.Key, u.Initiated.UTC().Format(time.RFC3339))
	}
	fmt.Fprintf(w, "== top %d videos by media bytes\n", top)
	ids := make([]string, 0, len(r.PerVideo))
	for id := range r.PerVideo {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return r.PerVideo[ids[i]] > r.PerVideo[ids[j]] })
	for i, id := range ids {
		if i == top {
			break
		}
		fmt.Fprintf(w, "  %s %12s\n", id, human(r.PerVideo[id]))
	}
}

// Selected returns the objects Delete would remove: those of the selected categories that are garbage. A
// live category passed by mistake selects nothing.
func (r *Report) Selected(cats map[Category]bool) []Object {
	var out []Object
	for _, o := range r.Objects {
		if cats[o.Category] && IsDeletable(o.Category) {
			out = append(out, o)
		}
	}
	return out
}

// Delete removes the objects of the selected categories (1000 keys per request) and aborts the stale
// multipart uploads when abortUploads is set. It returns the number of objects and bytes removed.
func (r *Report) Delete(ctx context.Context, c *s3.Client, cats map[Category]bool, abortUploads bool, rawBucket string) (int, int64, error) {
	byBucket := map[string][]Object{}
	for _, o := range r.Selected(cats) {
		byBucket[o.Bucket] = append(byBucket[o.Bucket], o)
	}
	var n int
	var bytes int64
	for bucket, objs := range byBucket {
		for i := 0; i < len(objs); i += 1000 {
			batch := objs[i:min(i+1000, len(objs))]
			ids := make([]types.ObjectIdentifier, len(batch))
			for j, o := range batch {
				ids[j] = types.ObjectIdentifier{Key: aws.String(o.Key)}
			}
			out, err := c.DeleteObjects(ctx, &s3.DeleteObjectsInput{Bucket: aws.String(bucket),
				Delete: &types.Delete{Objects: ids, Quiet: aws.Bool(true)}})
			if err != nil || len(out.Errors) > 0 {
				// Same fallback as s3x.DeletePrefix: some S3 servers reject bulk deletes (checksum quirks).
				if ctx.Err() != nil {
					return n, bytes, ctx.Err()
				}
				for _, o := range batch {
					if _, err := c.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(bucket), Key: aws.String(o.Key)}); err != nil {
						return n, bytes, fmt.Errorf("delete %s/%s: %w", bucket, o.Key, err)
					}
				}
			}
			for _, o := range batch {
				n++
				bytes += o.Size
			}
		}
	}
	if abortUploads {
		for _, u := range r.StaleUploads {
			if _, err := c.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{Bucket: aws.String(rawBucket),
				Key: aws.String(u.Key), UploadId: aws.String(u.UploadID)}); err != nil {
				return n, bytes, fmt.Errorf("abort %s: %w", u.Key, err)
			}
		}
	}
	return n, bytes, nil
}

func sortedKeys[T any](m map[string]T) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func human(b int64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := int64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.2f %ciB", float64(b)/float64(div), "KMGTPE"[exp])
}
