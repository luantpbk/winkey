package job

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/libs/go/hlsmaster"
)

// CacheImmutable is the Cache-Control of every media object: keys are never reused.
const CacheImmutable = cacheControlValue

// RewriteMaster downloads masterKey into dir, rewrites its audio group for ready (task MUX1) and uploads
// the result under hlsmaster.NewKey. The audio job uses it.
func RewriteMaster(ctx context.Context, objs Objects, bucket, dir, masterKey string, ready []hlsmaster.Track) (string, error) {
	local := filepath.Join(dir, "master-current.m3u8")
	if err := objs.Download(ctx, bucket, masterKey, local); err != nil {
		return "", fmt.Errorf("download master: %w", err)
	}
	return RewriteMasterFile(ctx, objs, bucket, local, masterKey, ready)
}

// RewriteMasterFile is RewriteMaster for a master that is already on disk at local (the pipeline, whose
// re-encoded video has READY audio tracks).
func RewriteMasterFile(ctx context.Context, objs Objects, bucket, local, masterKey string, ready []hlsmaster.Track) (string, error) {
	data, err := os.ReadFile(local) // #nosec G304 -- a file this process just wrote in its scratch dir
	if err != nil {
		return "", err
	}
	if len(data) > hlsmaster.MaxSize {
		return "", fmt.Errorf("master %s is larger than %d bytes", masterKey, hlsmaster.MaxSize)
	}
	newKey := hlsmaster.NewKey(masterKey, uuid.Must(uuid.NewV7()).String())
	out, err := hlsmaster.With(data, masterKey, newKey, hlsmaster.OriginalLabel, ready)
	if err != nil {
		return "", err
	}
	tmp := local + ".new"
	if err := os.WriteFile(tmp, out, 0o600); err != nil {
		return "", err
	}
	defer func() { _ = os.Remove(tmp) }()
	if err := objs.UploadFile(ctx, bucket, newKey, tmp, hlsmaster.ContentType, CacheImmutable); err != nil {
		return "", fmt.Errorf("upload master: %w", err)
	}
	return newKey, nil
}
