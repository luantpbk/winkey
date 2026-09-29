//go:build miniredis

package integration

import (
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
)

// Local runs without Docker (-tags miniredis). CI never uses this file.
type valkeyServer struct{ m *miniredis.Miniredis }

func startValkeyServer(t *testing.T) *valkeyServer { return &valkeyServer{m: miniredis.RunT(t)} }
func (s *valkeyServer) URL() string                { return "redis://" + s.m.Addr() }
func (s *valkeyServer) Stop(t *testing.T)          { s.m.Close() }

// wait lets d of Valkey time pass: miniredis expires keys only when told to.
func (s *valkeyServer) wait(d time.Duration) { s.m.FastForward(d) }
