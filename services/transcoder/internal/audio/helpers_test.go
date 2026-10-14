package audio

import (
	"os"

	"github.com/luantpbk/winkey/services/transcoder/internal/job"
)

const CacheImmutableForTest = job.CacheImmutable

func readFile(p string) ([]byte, error) { return os.ReadFile(p) } // #nosec G304 -- test temp file
