#!/usr/bin/env bash
# ENC2 calibration on gpu-01 (ADR-041): AV1 against the production H.264
# setting (capped_crf:27). One command, no sudo:
#
#   services/transcoder/scripts/enc2-bench.sh
#
# 1. Fetches the pinned FFmpeg 8.0 build (av1_nvenc that works with driver 595,
#    NVENC API 13.0, and libvmaf) into ~/tools/ffmpeg-8.0 and checks its sha256.
# 2. Runs enc1-bench.sh with that build for the AV1 encodes and for VMAF; the
#    H.264 baseline still uses the production FFmpeg 7.1.
# 3. Prints the verdict with the 25 % rule. Results stay in ~/enc2-bench-<timestamp>/.
#
# It never touches /opt/ffmpeg-7.1, the miner, ComfyUI or the driver.
set -euo pipefail

FF8_DIR="${FF8_DIR:-$HOME/tools/ffmpeg-8.0}"
# BtbN release build n8.0.1-66 (2026-02-28): its nv-codec-headers need NVENC API
# 13.0, which driver 595 provides; the current master build needs 13.1 (driver >= 610).
FF8_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-02-28-12-59/ffmpeg-n8.0.1-66-g27b8d1a017-linux64-gpl-8.0.tar.xz"
FF8_SHA256="26d2ecd0cefba99f9d1ea92252a3a4f743a58df4c1c3cf9f8bbaaa40b1fca5b0"

die() { echo "enc2-bench: $*" >&2; exit 1; }
[ "$(id -u)" -ne 0 ] || [ "${ENC1_ALLOW_ROOT:-0}" = 1 ] || die "do not run as root"

if [ ! -x "$FF8_DIR/bin/ffmpeg" ]; then
  echo "[enc2] downloading FFmpeg 8.0 into $FF8_DIR"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSLo "$tmp/ff8.tar.xz" "$FF8_URL"
  echo "$FF8_SHA256  $tmp/ff8.tar.xz" | sha256sum -c --quiet - || die "sha256 mismatch for $FF8_URL"
  mkdir -p "$FF8_DIR"
  tar -xJf "$tmp/ff8.tar.xz" -C "$FF8_DIR" --strip-components=1
fi
ff8="$FF8_DIR/bin/ffmpeg"
"$ff8" -hide_banner -nostdin -loglevel error -f lavfi -i testsrc2=s=1280x720:d=1 \
  -c:v av1_nvenc -cq 30 -f null - || die "$ff8: av1_nvenc does not work on this GPU/driver"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BENCH_NAME=enc2 \
  AV1_FFMPEG="$ff8" \
  VMAF_DIR="$FF8_DIR" \
  MIN_SAVED="${MIN_SAVED:-25}" \
  SETTINGS="${SETTINGS:-capped_crf:27,av1:28,av1:32,av1:36}" \
  exec "$here/enc1-bench.sh"
