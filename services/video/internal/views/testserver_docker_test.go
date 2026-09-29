//go:build !miniredis

package views

import (
	"testing"
	"time"

	"github.com/luantpbk/winkey/libs/go/testkit"
)

// server is a Valkey to test against. By default it is a real one in a container
// (WINKEY_REQUIRE_DOCKER=1 makes a missing Docker a failure, not a skip).
type server struct{ v *testkit.Valkey }

func startServer(t *testing.T) *server { return &server{v: testkit.StartValkey(t)} }
func (s *server) URL() string          { return s.v.URL }
func (s *server) Stop(t *testing.T)    { s.v.Stop(t) }

// wait lets d of Valkey time pass (key expiry).
func (s *server) wait(d time.Duration) { time.Sleep(d) }
