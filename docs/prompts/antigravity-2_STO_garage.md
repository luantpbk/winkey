# Kickoff — Antigravity 2 · Task STO (Garage S3 on k3s edge-1, buckets, CORS, web endpoint)

Do this right after EDGE (#39, merged). Everything goes in `deploy/k8s/storage/`. DATA comes next.

````text
# ROLE
You are the Platform/DevOps engineer on "Winkey". The architect (Claude Opus) reviews and merges your PRs.

# REPO
Worktree (AGENTS.md rule 8): git worktree add ../winkey-ag2-sto -b agent/ag2/sto-garage origin/main
READ FIRST: docs/DECISIONS.md (ADR-004, 005, 013, 014, 015), docs/INFRASTRUCTURE.md §0 and §5 (Garage 1 node
RF 1 now, data is disposable, ≈ 70 GB of the 110 GB local-path LV; buckets and lifecycle), deploy/compose/garage
(the dev bootstrap: same buckets, key, website and CORS — reuse its logic), deploy/k8s/edge (merged in #39:
ClusterIP `garage-s3` :3900 and `garage-web` :3902, NodePort `garage-s3-nodeport` 30900, all selecting
app.kubernetes.io/name: garage in namespace default; nginx sends Host `winkey-media.winkey.vn` to Traefik for
media.winkey.vn and Host `s3.winkey.vn` for the S3 API), libs/go/s3x (path-style addressing), services/upload
and services/transcoder .env.example (S3_* variables).
You own: deploy/ (this task: deploy/k8s/storage/ + the Ansible wiring). Branch: agent/ag2/sto-garage.

# TASK STO — deploy/k8s/storage (kustomize), single node now, target shape kept (ADR-013)
1. Garage (pinned version, same major as compose `dxflrs/garage:v1.x`, arm64) as a StatefulSet, 1 replica,
   label app.kubernetes.io/name: garage (so #39's Services and NodePort select it), requests/limits set
   (Winkey total on edge-1 ≤ 2 vCPU / 10 GB requests), PVCs on local-path: meta 1Gi, data 70Gi.
   garage.toml from a ConfigMap:
   - replication_factor = 1 (comment: RF 2 needs a new cluster + rclone, INFRASTRUCTURE §0), db_engine sqlite
     or lmdb (say why), rpc_secret from a Secret (never in git; document how to create it with `openssl rand -hex 32`).
   - [s3_api] s3_region = "garage", root_domain = ".s3.winkey.vn" (clients use path style, s3x UsePathStyle).
   - [s3_web] bind 3902, root_domain = ".winkey.vn" so Host `winkey-media.winkey.vn` serves bucket
     `winkey-media`; index = "index.html".
   - admin API on 3903 bound inside the cluster only (no Service exposed outside, no NodePort, no IngressRoute).
2. Bootstrap Job (idempotent, safe to re-run; same steps as deploy/compose/garage/bootstrap.sh):
   - layout assign with the real capacity (70G), zone `edge-1`, apply only when the layout changed;
   - buckets `winkey-raw`, `winkey-media`, `winkey-pg-backup` (the name the DATA brief uses);
   - one key per consumer, least privilege, keys written to k8s Secrets (never printed to logs, never in git):
       upload-svc   → winkey-raw read+write
       transcoder   → winkey-raw read, winkey-media read+write   (also exported for gpu-01, see 5.)
       video-svc    → winkey-media read+write (janitor deletes old attempts)
       pg-backup    → winkey-pg-backup read+write
   - website enabled on `winkey-media` only;
   - CORS on `winkey-raw`: AllowedOrigins https://winkey.vn and https://www.winkey.vn (variable, no `*`),
     AllowedMethods PUT GET HEAD, AllowedHeaders *, ExposeHeaders ETag, MaxAgeSeconds 3600;
     CORS on `winkey-media`: AllowedOrigins the same, AllowedMethods GET HEAD, AllowedHeaders Range,
     ExposeHeaders Content-Length Content-Range ETag.
   - lifecycle (INFRASTRUCTURE §5): Garage has no per-object "7 days after READY" rule, so do NOT invent one;
     note in the README that raw cleanup belongs to the services (follow-up), and set an
     AbortIncompleteMultipartUpload of 1 day on winkey-raw if the pinned Garage version supports it
     (say whether it does).
3. Ansible: extend roles/edge_ingress (or a new role `storage_k3s` in site.yml) to apply the kustomization with
   `k3s kubectl apply -k`, create the rpc Secret if missing (value from an env var / vault prompt, never
   committed), and wait for the bootstrap Job. Second run must report changed=0.
4. media.winkey.vn end to end: upload `v/smoke/hello.txt` into winkey-media with the video-svc key, then the
   #39 smoke test without SKIP_MEDIA must pass step 5 (HTTP 200, `X-Cache-Status: MISS` then `HIT`).
   Remove the smoke object afterwards or keep it under `v/smoke/` and document it.
5. gpu-01 transcoder (ADR-015): document in deploy/k8s/storage/README.md how the user copies the transcoder
   key into the systemd env file of services/transcoder/deploy/gpu-01 (S3_ENDPOINT=http://100.113.240.3:30900).
   Do not ssh into gpu-01 and do not use sudo there.

# DEFINITION OF DONE (paste real output in the PR, from edge-1 and from a machine outside edge-1)
- kubeconform (strict, with CRD schemas skipped only for CRDs) + kustomize build pass in CI for deploy/k8s/**
  (add the job if it does not exist yet; it is also on your queue).
- PLAY RECAP twice (second run changed=0).
- `garage status`, `garage layout show`, `garage bucket list`, `garage bucket info winkey-media` (website on),
  `garage key list` (names only) from the pod.
- From outside edge-1:
  • `aws s3api get-bucket-cors --bucket winkey-raw --endpoint-url https://s3.winkey.vn` with the upload key;
  • a presigned PUT to https://s3.winkey.vn/winkey-raw/smoke/test.bin from a browser-like request with
    `Origin: https://winkey.vn` → 200 and `ETag` visible in `Access-Control-Expose-Headers` (curl -i output);
  • preflight OPTIONS with `Origin: https://evil.example` → no Access-Control-Allow-Origin;
  • full `./deploy/edge/smoke-test.sh` (no SKIP_MEDIA) → 6/6 PASSED;
  • `nc -vz 138.2.93.173 3900 3902 3903 30900` all refused/timeout.
- From gpu-01 over Tailscale: `aws s3 ls s3://winkey-media --endpoint-url http://100.113.240.3:30900` with the
  transcoder key → works; the same key on winkey-pg-backup → AccessDenied.
- README in deploy/k8s/storage: run, configure (env/secret table), verify, and how to move to RF 2 / R2 later.
- No secrets in git (dummy values only in examples). The PR description is the Handoff Report.

# OUT OF SCOPE
- DATA (PostgreSQL/NATS/Valkey) — next task. Helm charts of the services (I2).
- Any change to services/*, contracts/, db/ (open an issue for the owner instead).
````
