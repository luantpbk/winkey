// Package partsize implements the multipart sizing rule of upload.v1.yaml:
// part_size = max(16 MiB, ceil(size / 10000)) rounded up to a whole MiB, so
// part_count never exceeds 10,000.
package partsize

const (
	MiB = int64(1) << 20
	// MinPartSize is the smallest part size we hand out.
	MinPartSize = 16 * MiB
	// MaxParts is the S3 limit on the number of parts.
	MaxParts = 10000
	// MaxSize is the largest accepted upload (20 GiB).
	MaxSize = int64(20) << 30
)

// Compute returns the part size and part count for an object of size bytes
// (size >= 1).
func Compute(size int64) (partSize int64, partCount int) {
	partSize = (size + MaxParts - 1) / MaxParts // ceil(size / 10000)
	partSize = (partSize + MiB - 1) / MiB * MiB // whole MiB
	if partSize < MinPartSize {
		partSize = MinPartSize
	}
	partCount = int((size + partSize - 1) / partSize)
	return partSize, partCount
}
