# Kickoff — Antigravity 2 · Beta ops: SEC0, #249, beta deploys, LT2 generator (ADR-034)

Design: ADR-034, which sets the order of the beta gates. These are four separate pieces of work. Each piece that
changes the repo gets its own branch and PR. Steps that only operate on hosts go in the issue or PR as real command
output.

````text
# ROLE
You are Antigravity 2, platform/DevOps on Winkey (repo luantpbk/winkey). You own deploy/, .github/workflows/* (except
contracts.yml), and root tooling. Security rules as always:
- never paste secrets in chat, PRs or git;
- secrets are entered on the host with `read -rs`;
- image digests come from CI logs only;
- no sudo on gpu-01;
- never touch the 4 legacy sites beyond what is written here.

# PART A — SEC0 (do first). Branch agent/ag2/sec0-edge-hardening
Repo:
- deploy/ansible/roles/firewall: remove the firewalld `cockpit` service and port `7890/tcp` from zone `public`
  (`state: disabled`, permanent + immediate). Cockpit stays reachable over tailscale0, which is the trusted zone.
- Add a role `ssh_hardening` with a drop-in `/etc/ssh/sshd_config.d/10-winkey.conf`:
  - `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `PermitRootLogin no`, `MaxAuthTries 3`;
  - `sshd -t` validate before reload;
  - a handler that reloads, never restarts.
  - Port 22 stays public (key-only) so OCI is not the only way back in.
- nginx_front: add a `www.winkey.vn` server block that answers 301 to `https://winkey.vn$request_uri`, and extend the
  certbot cert to include www (the same webroot/DNS method the role already uses).
Host:
1. BEFORE the SSH change: confirm key login for the user's account works, and keep a second SSH session open during the
   reload.
2. Run the playbook with `--check --diff` first, then for real.
3. PostgreSQL host: show `ss -ltnp | grep 5432`. It must listen on 127.0.0.1 (plus any internal address the existing
   apps need). Change `listen_addresses` only if it is wider than that, and restart only in the 02:00–05:00 window.
4. The OCI security list / NSG for edge-1 must allow ONLY 22, 80, 443/tcp and 41641/udp from the internet. If 9090 or
   7890 are open there, write the exact console steps for the user. You cannot change OCI yourself.
5. The user creates the DNS record in Cloudflare: `www` CNAME `winkey.vn`, using the same proxy status as the apex.
   Give the user that one line.
Verify from OUTSIDE the tailnet: use an external port checker, or the LT2 VM before it joins the tailnet. Never turn
tailscale off on gpu-01.
- 9090 and 7890 time out; 22 asks only for a public key;
- `https://www.winkey.vn` → 301 → `https://winkey.vn`;
- the 4 legacy sites still answer 200.

# PART B — #249 test accounts (after A)
Follow issue #249 exactly, using the product API only and never SQL. The architect has decided the keep-list:
- KEEP only accounts with role `admin` that the user confirms are theirs. Post the list of handles in the issue and ask
  the user to answer yes/no in one line.
- Every other account matching `usr_*`, `u_*`, `smoke_demo1_*` or `sec1_tester`, or created by agents or smoke tests,
  is suspended. Delete it with deleteMe where the credentials are known.
- Smoke scripts in deploy/ that register users must now:
  - use a dedicated invite code from a host-only env file (`read -rs`);
  - delete their throwaway account at the end (deleteMe).
  This is a small repo PR: agent/ag2/smoke-throwaway-accounts.

# PART C — Beta deploys (each after the matching app PR is merged; digests from CI logs)
1. BETA1 (auth-svc):
   - generate 2 codes on the host: `openssl rand -hex 10 | sed 's/^/wk-beta1-/'` for the first wave, and one for
     LT2/smoke;
   - put them in the auth Secret as `INVITE_CODES` through secrets.sh (`read -rs`);
   - set `REGISTRATION_MODE=invite`;
   - roll out auth.
   Verify:
   - register without a code → 403 INVITE_REQUIRED;
   - with the smoke code → 201, then that account is deleted;
   - existing users still log in;
   - no code appears in Loki (`{app="auth"} |= "wk-beta1"` returns nothing).
   Give the first-wave code to the USER only, via a file on edge-1 they read themselves (mode 0600). Never put it in
   chat or a PR.
2. CIN1 (web): add the web env `CINEMA_CURATOR_HANDLE` (the handle the user picks; empty is fine at first) and
   `FEEDBACK_URL` (empty until the user gives one), then pin the digest and roll out. Verify:
   - `/` shows the cinema home;
   - `/?tab=trending` → `/kham-pha?tab=trending`;
   - `/phim` → `/`.
3. BETA1-web (web): pin the digest and roll out. Verify `/dieu-khoan`, `/quyen-rieng-tu` and `/quy-tac-cong-dong`
   return 200, and that the register page shows the invite field.

# PART D — LT2 load generator (for Antigravity 4)
- The user creates ONE temporary OCI A1 VM in the same region as edge-1: Ubuntu 24.04 arm64, 2 OCPU / 12 GB (the
  remaining free tier), public IP, with security list egress open and ingress 22 only. Write the user the exact console
  steps.
- Bootstrap: docker, tailscale with an EPHEMERAL auth key tagged `tag:loadgen` (the user creates the key), and no
  other services. Give the user the policy snippet: `tag:loadgen` may reach nothing on the tailnet except being
  reached on :22 by the user's devices. The load goes to the PUBLIC https://winkey.vn, like real viewers. Give Antigravity 4 SSH access via the tailnet.
- After LT2 (the same night): `tailscale logout`, then the user terminates the VM and boot volume. Confirm in the
  issue that it is gone.

# DEFINITION OF DONE
- Each repo PR: ansible-lint / yamllint / CI are green, and the PR is the Handoff Report with real outputs.
- Comment on issue #47 with the external port scan result (A), the account counts before/after (B), the rollout
  verifications (C), and the VM-deleted confirmation (D).
````
