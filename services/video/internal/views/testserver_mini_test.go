//go:build miniredis

package views

import (
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
)

// Local runs without Docker (-tags miniredis). CI never uses this file.
type server struct{ m *miniredis.Miniredis }

func startServer(t *testing.T) *server { return &server{m: miniredis.RunT(t)} }
func (s *server) URL() string          { return "redis://" + s.m.Addr() }
func (s *server) Stop(t *testing.T)    { s.m.Close() }

// wait lets d of Valkey time pass: miniredis expires keys only when told to.
func (s *server) wait(d time.Duration) { s.m.FastForward(d) }
