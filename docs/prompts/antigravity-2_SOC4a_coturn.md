# Antigravity 2 — SOC-4a: coturn and call plumbing

Read the SOC-4a addendum (2026-10-31) at the end of `docs/DECISIONS.md`. Work in `deploy/` (and CI if needed).
Apply to production only after merge.

1. **Gateway route:** `PathPrefix(/v1/people)` → social-svc (SOC-6a, #530), with the same `strip-user-headers` and
   optional-auth middlewares as the other social routes. Do it in compose, systest and k8s, and add a smoke test.
2. **coturn on the edge** (a multi-arch image, pinned by digest), `use-auth-secret` with `static-auth-secret` =
   `TURN_SECRET`:
   - `realm=winkey.vn`, `no-multicast-peers`, `no-cli`, `fingerprint`, `no-tcp-relay` unless needed;
   - `denied-peer-ip` for 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12,
     192.168.0.0/16, ::1, fc00::/7 and fe80::/10, plus the cluster pod and service CIDRs;
   - TLS on 5349 (and 443/tcp if a port is free), reusing the winkey.vn certificate;
   - a relay port range (for example 49160–49200/udp) opened in the firewall; `user-quota`, `total-quota` and
     `max-bps` set;
   - Prometheus metrics (`--prometheus`), scraped, with a dashboard panel for sessions and bandwidth.
3. **Secrets and env:**
   - generate `TURN_SECRET` on the host (`openssl rand -base64 48`), entered with `read -rs`, never pasted;
   - put it in both the coturn config secret and `chat-secrets`;
   - give chat-svc `TURN_URLS=turn:turn.winkey.vn:3478?transport=udp,turns:turn.winkey.vn:5349?transport=tcp`
     (adjust to what you expose).
   - DNS: `turn.winkey.vn` must not be proxied by Cloudflare (DNS only).
4. **Header:** at the ingress, add `Permissions-Policy: camera=(self), microphone=(self), display-capture=()` to web
   responses. Check that nothing else sets a conflicting one.
5. **Verify:**
   - with a TURN client (`turnutils_uclient`, using credentials from `getTurnCredentials`), allocate a relay and
     send data;
   - check that relaying to 127.0.0.1 or 10.x is refused;
   - report on the PR without IPs or secrets.
