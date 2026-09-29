# Transcoder on gpu-01 (systemd)

ADR-015: the transcoder is a standalone pull worker on gpu-01. It only opens **outbound** connections
(NATS, PostgreSQL, Garage on edge-1, over Tailscale) and takes no traffic. It runs as the systemd service
`winkey-transcoder`. gpu-01 is shared: the GPU also runs a miner and ComfyUI, so the service runs at low
priority and with the settings measured for a shared GPU (`docs/INFRASTRUCTURE.md` section 6).

| File | Purpose |
|---|---|
| [`winkey-transcoder.service`](winkey-transcoder.service) | the unit (`/etc/systemd/system/`) |
| [`transcoder.env.example`](transcoder.env.example) | template of `/etc/winkey/transcoder.env` (placeholders only) |
| [`install.sh`](install.sh) | build, install, upgrade, roll back, status. Never calls sudo. |

Ansible will wrap these later (Antigravity 2); this directory is the source of truth for what gets installed.

## What is where

| Path | What |
|---|---|
| `/opt/winkey/transcoder/<git-sha>/` | one directory per installed version: `transcoder`, `replay-dlq`, `VERSION` |
| `/opt/winkey/transcoder/current`, `previous` | symlinks: what runs, and what `rollback` returns to |
| `/etc/winkey/transcoder.env` | configuration and credentials, `root:root` `0600` |
| `/etc/systemd/system/winkey-transcoder.service` | the unit |
| `/mnt/nvme_models/winkey/scratch` | `SCRATCH_DIR` (fast NVMe), group `winkey` |
| `/mnt/hdd_storage/winkey/archive` | `ARCHIVE_DIR` (raw archive), group `winkey` |
| `/opt/ffmpeg-7.1/bin/{ffmpeg,ffprobe}` | FFmpeg n7.1.5 with NVENC (`FFMPEG_PATH`, `FFPROBE_PATH`) |

The service user `winkey-transcoder` is a system user in the groups `video` and `render` (GPU device nodes)
and `winkey` (owns scratch and archive). It has no shell and no home.

## 1. First install

Run as the normal operator user (no sudo) from a checkout of the repository:

```bash
cd services/transcoder/deploy/gpu-01
./install.sh install
```

It builds a static `linux/amd64` binary, smoke-tests it, installs it under `/opt/winkey/transcoder/<sha>/` and
points `current` at it. Then it **prints** the steps that need root, leaving out those already done. Run them
yourself:

1. Once, before the script can install anything: `sudo install -d -m 0755 -o "$USER" -g winkey /opt/winkey /opt/winkey/transcoder`
   (the script prints this if the directory is missing).
2. The service user: `sudo useradd --system --user-group --no-create-home --shell /usr/sbin/nologin --groups video,render,winkey winkey-transcoder`
   (check first: `getent group video render winkey`).
3. The environment file, then fill in the real values (edge-1 Tailscale IP, database password, S3 keys):
   ```bash
   sudo install -d -m 0755 /etc/winkey
   sudo install -m 0600 -o root -g root transcoder.env.example /etc/winkey/transcoder.env
   sudoedit /etc/winkey/transcoder.env
   ```
   The edge-1 side (NodePorts 30422 NATS, 30432 PostgreSQL, 30900 Garage on the Tailscale IP, role `media_svc`, the
   `tag:gpu` ACL) is provisioned by task DATA; the service cannot start without it.
4. The unit, verified before it is used:
   ```bash
   sudo install -m 0644 winkey-transcoder.service /etc/systemd/system/winkey-transcoder.service
   sudo systemctl daemon-reload
   systemd-analyze verify /etc/systemd/system/winkey-transcoder.service
   ```
5. Start it and enable it at boot: `sudo systemctl enable --now winkey-transcoder`.
6. Check the service user can write the working directories:
   `sudo -u winkey-transcoder test -w /mnt/nvme_models/winkey/scratch && echo ok` (same for the archive).

Then `./install.sh status` and the checks in section 4.

## 2. Upgrade and roll back

```bash
git pull
./install.sh upgrade          # builds the checked-out commit, switches `current`, prints the restart
sudo systemctl restart winkey-transcoder
./install.sh status
```

`upgrade` refuses a tree with uncommitted changes (`ALLOW_DIRTY=1` overrides; the version is then named
`<sha>-dirty-<time>`), keeps the newest 5 versions (`KEEP=n`), and tells you when the unit file in the checkout
differs from the installed one (install it and `daemon-reload` before restarting).

```bash
./install.sh rollback         # `current` <- `previous` (and previous <- the version you left)
sudo systemctl restart winkey-transcoder
```

Running `rollback` again toggles back. A restart is always safe (section 5): running jobs get their grace period,
then go back to the queue.

## 3. Logs

Logs are one JSON object per line with `ts`, `level`, `msg`, `service`, `trace_id`, `request_id`:

```bash
journalctl -u winkey-transcoder -o cat -f                                   # follow
journalctl -u winkey-transcoder -o cat --since "1 hour ago" | jq -c 'select(.level=="error")'
journalctl -u winkey-transcoder -o cat | jq -c 'select(.video_id=="<uuid>")'   # one video's history
journalctl -u winkey-transcoder -o cat | jq -c 'select(.msg=="transcode succeeded")'   # speed: .x_realtime
```

Useful messages: `starting` (encoder, concurrency, `hwaccel_decode`), `transcode succeeded` / `transcode failed`
(`reason`, `retryable`), `nvenc failed; retrying with x264`, `interrupted by shutdown; nak`,
`reconciled lost job`, `gave up on video after max deliveries`. Logs never contain tokens, passwords or emails.
Your user needs group `adm` or `systemd-journal` to read the journal.

## 4. Checking that it works

```bash
./install.sh status                                   # versions, service, unit, env file, /readyz
curl -s http://127.0.0.1:8081/readyz                  # postgres, nats, s3 (use the HTTP_ADDR of the env file)
curl -s http://127.0.0.1:8081/metrics | grep -E '^transcoder_'   # jobs_total, jobs_in_flight, encode_realtime_ratio
```

GPU (`nvidia-smi` shows the miner and ComfyUI too; the transcoder is the process running `ffmpeg`):

```bash
nvidia-smi                                            # utilisation, VRAM, processes
nvidia-smi dmon -s um                                 # while a job runs: sm / mem / enc / dec utilisation
nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv
# The service user can reach the GPU (groups video + render). This checks device access only; the unit's sandbox is not applied:
sudo -u winkey-transcoder /opt/ffmpeg-7.1/bin/ffmpeg -hide_banner -f lavfi -i color=c=black:s=640x360:d=0.2:r=25 -frames:v 1 -c:v h264_nvenc -f null - && echo NVENC ok
# NVENC inside the hardened service: the first real job logs the encoder it used ("nvenc", not a fallback to "x264"):
journalctl -u winkey-transcoder -o cat | jq -c 'select(.msg=="transcode succeeded") | {video_id, encoder, x_realtime}'
journalctl -u winkey-transcoder -o cat | grep -c 'nvenc failed'      # 0 expected
systemd-analyze security winkey-transcoder            # exposure score of the unit
```

A busy GPU is normal here: with the miner running, one job reaches about 5.6x realtime with CPU decode and
NVENC, and NVENC is already saturated by that one job.

## 5. Stopping safely

```bash
sudo systemctl stop winkey-transcoder       # or restart; both are safe at any time
```

What happens: systemd sends SIGTERM to the worker (only; `KillMode=mixed`). The worker stops taking new jobs,
lets running jobs finish for `SHUTDOWN_GRACE` (30 s), then cancels them, kills their ffmpeg, closes the job row and
hands the message back to the queue (the video stays `PROCESSING`; the owner is not told it failed). Another
worker, or this one after the restart, picks it up. `TimeoutStopSec=60` is `SHUTDOWN_GRACE` + 30 s; if the
process is somehow still alive then, systemd SIGKILLs the whole cgroup.

A job that was **killed instead of stopped** (SIGKILL, power loss, reboot without a clean stop) leaves a `RUNNING`
row: the stuck-job reconciler notices the missing heartbeat after `STALE_JOB_AFTER` (10 min) and retries the video
or fails it after `MAX_JOB_ATTEMPTS` attempts. Leftover scratch directories are removed at the next start.

To pause transcoding for maintenance: stop the service. Messages wait in NATS (7 days); nothing is lost.
To re-run videos that ended up in the dead-letter queue: `replay-dlq` from the current version, e.g.
`NATS_URL=... /opt/winkey/transcoder/current/replay-dlq -dry-run`.

## 6. What you can change while the GPU is busy

Edit the env file and restart (there is no live reload; a restart is safe, section 5):

```bash
sudoedit /etc/winkey/transcoder.env && sudo systemctl restart winkey-transcoder
```

| Variable | Change it when | Effect |
|---|---|---|
| `HWACCEL_DECODE` | GPU busy (miner): keep `false`. Set `true` only on an idle GPU | `false` decodes on the CPU and encodes on NVENC; NVDEC decode measured ~2x slower on the shared GPU |
| `WORKER_CONCURRENCY` | 1 while NVENC is saturated; 2 adds ~5 % total throughput and doubles per-job latency | jobs in parallel (each NVENC job uses 3 sessions; the GeForce limit is about 8) |
| `ENCODER` | NVENC unavailable or the GPU is needed by something else: `x264` | `x264` is CPU only (~5.2x realtime here, 77 % of the 32 threads); `nvenc` needs a working GPU |
| `X264_PRESET` | with `x264`: `ultrafast`/`superfast` to go faster, `medium` for quality | x264 preset |
| `UPLOAD_PARALLELISM` | home uplink congested: lower it | parallel uploads to Garage per job |
| `LOG_LEVEL` | debugging: `debug` | log verbosity |
| `SHUTDOWN_GRACE` | jobs are long and stops should let them finish | **also raise the unit's `TimeoutStopSec` to grace + 30 s** (drop-in below) |

Not changeable here without more than an env edit: `SCRATCH_DIR` / `ARCHIVE_DIR` (also `ReadWritePaths=` in the
unit, below), `FFMPEG_PATH` / `FFPROBE_PATH` (a new FFmpeg build is a separate change, and the images pin the same
version), and everything that points at edge-1.

### Overriding the unit (paths, timeouts)

`systemd` cannot read `ReadWritePaths=` from the env file, so moving the scratch or archive directory needs a drop-in:

```bash
sudo systemctl edit winkey-transcoder
# [Service]
# ReadWritePaths=
# ReadWritePaths=/new/scratch/path
# ReadWritePaths=-/new/archive/path
# TimeoutStopSec=90
sudo systemctl restart winkey-transcoder
```

(An empty `ReadWritePaths=` line first clears the list from the main unit.) The repository's unit stays the
reference; a unit test keeps it consistent with `transcoder.env.example`.

## 7. Hardening, and what it must not break

The unit sets `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, kernel/clock/hostname
protections, a restricted address-family and namespace set, no capabilities, and writable paths limited to scratch
and archive. **`PrivateDevices` is deliberately not set**: it hides `/dev/nvidia*` and NVENC would stop working.
`MemoryDenyWriteExecute`, `ProcSubset=pid` and a `SystemCallFilter` are also left out because the NVIDIA libraries
map executable memory, read `/proc/driver/nvidia` and use many ioctls.
`-hwaccel cuda` (only with `HWACCEL_DECODE=true`) additionally needs the `nvidia-uvm` kernel module to be loaded;
`nvidia-modprobe` cannot load it under `NoNewPrivileges`. It is loaded while the miner or ComfyUI runs; on a machine
where nothing else uses CUDA, load it at boot (`/etc/modules-load.d/`). The default `HWACCEL_DECODE=false` needs
only NVENC.

## 8. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Main process exited, code=exited, status=2` and no restart | invalid configuration (missing or malformed variable): `journalctl -u winkey-transcoder -o cat -n 20` names them; fix `/etc/winkey/transcoder.env` |
| `status=216/GROUP` or `217/USER` | the user or its groups do not exist: create them (section 1, step 2) |
| `status=226/NAMESPACE` | a path in `ReadWritePaths=` does not exist (the scratch directory is required, the archive is optional) |
| `status=203/EXEC` | `current` does not point at a working version: `./install.sh status` |
| `nvenc failed; retrying with x264` in the log | the encoder could not start: is the GPU visible to the user (`id winkey-transcoder` must show `video` and `render`)? Is another process holding all NVENC sessions? Jobs still complete with x264 |
| `permission denied` writing under scratch | the service user is not in group `winkey`, or the directory is not group-writable |
| readiness is red for `nats` / `postgres` / `s3` | the Tailscale path or ACL to edge-1 (`tailscale status`, ports 30422 / 30432 / 30900), or the credentials |
| jobs sit in `PROCESSING` after a crash | wait for the reconciler (10 min), or check `transcoder_reconciled_jobs_total` |
