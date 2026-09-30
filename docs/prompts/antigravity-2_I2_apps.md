# Kickoff — Antigravity 2 · Task I2 (deploy every Winkey service on k3s edge-1)

Starts after DATA (#81, merged). Same pattern as STO/DATA: **kustomize + an Ansible role**, no Helm and no
GitOps controller yet (ADR-011/013: one small VPS). GitOps (Flux) is a later task once there are several nodes.

````text
# ROLE
You are the Platform/DevOps engineer on "Winkey". The architect (Claude Opus) reviews and merges your PRs.

# REPO
Worktree (AGENTS.md rule 8): git worktree add ../winkey-ag2-i2 -b agent/ag2/i2-apps origin/main
READ FIRST: deploy/k8s/edge (IngressRoutes, middlewares, forwardAuth, NodePorts), deploy/k8s/data (Secrets from
secrets.sh, service names winkey-pg-rw / nats / valkey, NetworkPolicies on app.kubernetes.io/part-of: winkey),
deploy/k8s/storage (garage-key-* Secrets), each service README + .env.example (env table, ports, health paths),
.github/workflows (images ghcr.io/luantpbk/winkey-<name>), docs/DECISIONS.md ADR-009, 014, 017.
You own: deploy/, .github/workflows (except contracts.yml). Branch: agent/ag2/i2-apps.

# TASK I2
1. deploy/k8s/apps/<svc>/ (kustomize) for web, auth, upload, video, social, realtime:
   - Deployment (1 replica), Service (ClusterIP), labels app.kubernetes.io/name=<svc> and
     app.kubernetes.io/part-of=winkey (required by the DATA NetworkPolicies);
   - image ghcr.io/luantpbk/winkey-<svc> pinned by DIGEST (a kustomize `images:` entry per env, updated by a
     script/Ansible var — never :latest);
   - env from ConfigMap + Secrets only; DSNs per service role (auth_svc, media_svc for upload/video, social_svc),
     NATS user per service, Valkey password, garage-key-upload-svc / garage-key-video-svc;
     video-svc needs MEDIA_LINK_SECRET (≥ 32 bytes, generated once, stored in a Secret AND exported for the
     nginx template of SEC1-b); auth JWT keys + COOKIE_SECRET generated once (secrets.sh style, idempotent);
   - ports: social HTTP_PORT=3004, realtime container port named `http` (HTTP_PORT=3005), the rest per README;
   - readiness /readyz, liveness /healthz, resources requests/limits, securityContext (non-root, read-only root
     FS where the image allows, drop ALL caps), terminationGracePeriod ≥ the service's shutdown grace;
   - TRUST_PROXY_CIDRS = the k3s pod CIDR of Traefik (10.42.0.0/16) so services read X-Forwarded-For from
     Traefik only.
2. Traefik routes (deploy/k8s/edge): every API route gets `Host(winkey.vn) || Host(www.winkey.vn)`; add
   /v1/admin, /v1/reports, /v1/moderation (auth/social per contracts), /v1/search (video), the social comment/like
   PathRegexp with higher priority than /v1/videos (social.v1.yaml info), /v1/realtime (websocket) → realtime.
   forwardAuth + identity-header stripping on every route exactly as EDGE. X-Forwarded-For must reach services.
3. Ansible role apps_k3s (idempotent, second run changed=0, kubectl diff for drift like STO) + site.yml.
4. CI: kubeconform for deploy/k8s/apps; a check that every Deployment has part-of: winkey, probes, resources.
5. Resource budget: requests of apps ≤ 1.5 vCPU / 3 GB total (data plane already uses ~450m / 1.1 GB).

# DEFINITION OF DONE (real output from edge-1 and from outside, pasted in the PR)
- PLAY RECAP twice (second changed=0); kubectl get pods (all Running/Ready); kubeconform output.
- From outside: register → login → GET /v1/auth/me (200); GET /v1/videos (200); GET /v1/search?q=test (200);
  /v1/realtime upgrade (101) with a ticket; POST /v1/uploads (201) for a small file then the object in Garage;
  identity headers sent by the client are stripped (whoami or a service log line); a request with a forged
  X-Forwarded-For does not change the IP a service rate-limits on.
- The smoke test (deploy/edge/smoke-test.sh) extended with these checks, 100% PASS.
- README deploy/k8s/apps: apply order, secrets, how to roll a new image digest, rollback.

# OUT OF SCOPE
SEC1-b nginx changes (next task), transcoder on gpu-01 (outside k3s, ADR-015), GitOps, autoscaling.
````
