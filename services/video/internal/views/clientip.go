// Package views implements the view counter of task C3: a qualified-playback
// report is deduplicated and rate limited in Valkey, buffered there, and added
// to media.videos.view_count in batches.
package views

import (
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"strings"
)

// ParseCIDRs parses TRUST_PROXY_CIDRS entries. A bare address means /32 or /128.
func ParseCIDRs(entries []string) ([]netip.Prefix, error) {
	out := make([]netip.Prefix, 0, len(entries))
	for _, e := range entries {
		e = strings.TrimSpace(e)
		if e == "" {
			continue
		}
		if p, err := netip.ParsePrefix(e); err == nil {
			out = append(out, p.Masked())
			continue
		}
		a, err := netip.ParseAddr(e)
		if err != nil {
			return nil, fmt.Errorf("%q is neither a CIDR nor an address", e)
		}
		out = append(out, netip.PrefixFrom(a.Unmap(), a.Unmap().BitLen()))
	}
	return out, nil
}

func trusted(a netip.Addr, proxies []netip.Prefix) bool {
	a = a.Unmap()
	for _, p := range proxies {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

// ClientIP returns the address of the client behind the request, with the same
// semantics as auth-svc's trustProxy (Fastify / proxy-addr):
//
//   - the peer (RemoteAddr) is the client unless it is a trusted proxy;
//   - if the peer is trusted, X-Forwarded-For is read from the RIGHT: trusted
//     addresses are skipped, and the first address that is not trusted is the
//     client. Everything to the left of it is client-supplied and ignored, so a
//     client cannot choose its own address by sending a forged header;
//   - if every hop is trusted (or the header is empty or unparseable), the
//     left-most valid address, or the peer, is used.
//
// X-Forwarded-For from a peer that is not trusted is ignored entirely.
func ClientIP(r *http.Request, proxies []netip.Prefix) string {
	peer := peerAddr(r.RemoteAddr)
	if !peer.IsValid() {
		return ""
	}
	if !trusted(peer, proxies) {
		return peer.Unmap().String()
	}
	var hops []string
	for _, h := range r.Header.Values("X-Forwarded-For") {
		hops = append(hops, strings.Split(h, ",")...)
	}
	last := peer
	for i := len(hops) - 1; i >= 0; i-- {
		a, err := netip.ParseAddr(strings.TrimSpace(hops[i]))
		if err != nil {
			return last.Unmap().String() // garbage in the chain: do not trust anything to its left
		}
		last = a
		if !trusted(a, proxies) {
			return a.Unmap().String()
		}
	}
	return last.Unmap().String()
}

func peerAddr(remote string) netip.Addr {
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		host = remote
	}
	a, err := netip.ParseAddr(strings.Trim(host, "[]"))
	if err != nil {
		return netip.Addr{}
	}
	return a
}
