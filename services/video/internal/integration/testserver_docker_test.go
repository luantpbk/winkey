//go:build !miniredis

package integration

import (
	"testing"
	"time"

	"github.com/luantpbk/winkey/libs/go/testkit"
)

// valkeyServer is a Valkey to test against. By default it is a real one in a
// container (WINKEY_REQUIRE_DOCKER=1 makes a missing Docker a failure, not a skip).
type valkeyServer struct{ v *testkit.Valkey }

func startValkeyServer(t *testing.T) *valkeyServer { return &valkeyServer{v: testkit.StartValkey(t)} }
func (s *valkeyServer) URL() string                { return s.v.URL }
func (s *valkeyServer) Stop(t *testing.T)          { s.v.Stop(t) }

// wait lets d of Valkey time pass (key expiry).
func (s *valkeyServer) wait(d time.Duration) { time.Sleep(d) }
