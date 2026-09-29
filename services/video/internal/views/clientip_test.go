package views

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func req(remote string, xff ...string) *http.Request {
	r := httptest.NewRequest("POST", "/v1/videos/x/views", nil)
	r.RemoteAddr = remote
	for _, v := range xff {
		r.Header.Add("X-Forwarded-For", v)
	}
	return r
}

func TestClientIP(t *testing.T) {
	proxies, err := ParseCIDRs([]string{"10.42.0.0/16", "127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name   string
		remote string
		xff    []string
		want   string
	}{
		{"direct client, no header", "203.0.113.7:5555", nil, "203.0.113.7"},
		{"untrusted peer forging the header is ignored", "203.0.113.7:5555", []string{"198.51.100.9"}, "203.0.113.7"},
		{"trusted proxy, one hop", "10.42.0.5:4000", []string{"198.51.100.9"}, "198.51.100.9"},
		{"trusted proxy, header empty", "10.42.0.5:4000", nil, "10.42.0.5"},
		{"client-supplied left part is ignored", "10.42.0.5:4000", []string{"1.1.1.1, 198.51.100.9"}, "198.51.100.9"},
		{"skips trusted hops from the right", "10.42.0.5:4000", []string{"198.51.100.9, 10.42.3.3"}, "198.51.100.9"},
		{"several header lines are one chain", "127.0.0.1:1", []string{"9.9.9.9", "198.51.100.9"}, "198.51.100.9"},
		{"every hop trusted: left-most", "10.42.0.5:4000", []string{"10.42.1.1, 10.42.2.2"}, "10.42.1.1"},
		{"garbage stops the walk", "10.42.0.5:4000", []string{"6.6.6.6, not-an-ip"}, "10.42.0.5"},
		{"ipv6 client", "10.42.0.5:4000", []string{"2001:db8::1"}, "2001:db8::1"},
		{"ipv6 peer", "[2001:db8::2]:443", nil, "2001:db8::2"},
		{"v4-mapped peer is trusted like v4", "[::ffff:10.42.0.5]:4000", []string{"198.51.100.9"}, "198.51.100.9"},
		{"loopback proxy", "127.0.0.1:9", []string{"198.51.100.9"}, "198.51.100.9"},
		{"unparseable peer", "weird", nil, ""},
	}
	for _, c := range cases {
		if got := ClientIP(req(c.remote, c.xff...), proxies); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
	// With no trusted proxies the header is never used.
	if got := ClientIP(req("10.42.0.5:4000", "198.51.100.9"), nil); got != "10.42.0.5" {
		t.Errorf("no proxies configured: %q", got)
	}
}

func TestParseCIDRs(t *testing.T) {
	got, err := ParseCIDRs([]string{" 10.42.0.0/16 ", "127.0.0.1", "::1", "", "10.42.7.9/16"})
	if err != nil || len(got) != 4 {
		t.Fatalf("%v %v", got, err)
	}
	if got[0].String() != "10.42.0.0/16" || got[1].String() != "127.0.0.1/32" || got[2].String() != "::1/128" || got[3].String() != "10.42.0.0/16" {
		t.Fatalf("%v", got)
	}
	for _, bad := range []string{"nope", "10.0.0.0/33", "300.1.1.1"} {
		if _, err := ParseCIDRs([]string{bad}); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}
