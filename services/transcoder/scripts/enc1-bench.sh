#!/usr/bin/env bash
# ENC1 calibration on gpu-01 (ADR-039). One command, no sudo:
#
#   services/transcoder/scripts/enc1-bench.sh
#
# 1. Fetches a static FFmpeg with libvmaf into ~/tools/ffmpeg-vmaf (once).
# 2. Picks SAMPLES raw uploads from the transcoder archive (sizes spread
#    evenly) and cuts the first CLIP_SECONDS of each into a scratch directory.
# 3. Runs cmd/quality-bench with NVENC and the production FFmpeg on settings
#    abr, capped_crf:21, :23, :25, :27 and prints the ADR-039 verdict with the
#    recommended NVENC_CQ.
# 4. Deletes the clips. Results stay in ~/enc1-bench-<timestamp>/.
#
# It reads the archive only, never the env file or S3 credentials, and never
# touches /opt/ffmpeg-7.1, the miner or ComfyUI. Run it off-peak: it shares the
# GPU like the transcoder does (nice/ionice, one encode at a time).
set -euo pipefail

ARCHIVE_DIR="${ARCHIVE_DIR:-/mnt/hdd_storage/winkey/archive}"
SCRATCH_ROOT="${SCRATCH_ROOT:-/mnt/nvme_models/winkey/scratch}"
FFMPEG="${FFMPEG:-/opt/ffmpeg-7.1/bin/ffmpeg}"
FFPROBE="${FFPROBE:-/opt/ffmpeg-7.1/bin/ffprobe}"
SAMPLES="${SAMPLES:-20}"
CLIP_SECONDS="${CLIP_SECONDS:-60}"
SETTINGS="${SETTINGS:-abr,capped_crf:21,capped_crf:23,capped_crf:25,capped_crf:27}"
ENCODER="${ENCODER:-nvenc}" # x264 only for a dry run off gpu-01
VMAF_DIR="${VMAF_DIR:-$HOME/tools/ffmpeg-vmaf}"
VMAF_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
module="$(cd "$here/.." && pwd)"
out="$HOME/enc1-bench-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$out"

die() { echo "enc1-bench: $*" >&2; exit 1; }

# --- preflight ---------------------------------------------------------------
[ "$(id -u)" -ne 0 ] || [ "${ENC1_ALLOW_ROOT:-0}" = 1 ] || die "do not run as root"
command -v go >/dev/null || die "go not found (the same toolchain install.sh uses)"
[ -x "$FFMPEG" ] && [ -x "$FFPROBE" ] || die "production FFmpeg not found at $FFMPEG"
if [ "$ENCODER" = nvenc ]; then
  grep -q h264_nvenc <<<"$("$FFMPEG" -hide_banner -encoders 2>/dev/null)" || die "$FFMPEG has no h264_nvenc"
fi
[ -r "$ARCHIVE_DIR" ] || die "cannot read $ARCHIVE_DIR (operator must be in group winkey)"
[ -w "$SCRATCH_ROOT" ] || SCRATCH_ROOT="${TMPDIR:-/tmp}"
work="$(mktemp -d "$SCRATCH_ROOT/enc1-bench.XXXXXX")"
trap 'rm -rf "$work"' EXIT

if [ ! -x "$VMAF_DIR/bin/ffmpeg" ]; then
  echo "[enc1] downloading FFmpeg with libvmaf into $VMAF_DIR"
  mkdir -p "$VMAF_DIR"
  curl -fsSL "$VMAF_URL" | tar -xJ -C "$VMAF_DIR" --strip-components=1
fi
grep -q libvmaf <<<"$("$VMAF_DIR/bin/ffmpeg" -hide_banner -filters 2>/dev/null)" || die "$VMAF_DIR/bin/ffmpeg has no libvmaf"

echo "[enc1] building quality-bench"
(cd "$module" && go build -o "$work/quality-bench" ./cmd/quality-bench)

# --- pick sources: SAMPLES files spread evenly over the size distribution ------
mapfile -t all < <(find "$ARCHIVE_DIR" -type f -size +1M -printf '%s\t%p\n' 2>/dev/null | sort -n | cut -f2-)
n=${#all[@]}
[ "$n" -gt 0 ] || die "no files in $ARCHIVE_DIR"
[ "$SAMPLES" -le "$n" ] || SAMPLES=$n
echo "[enc1] $n archived uploads, sampling $SAMPLES"
clips=()
for ((k = 0; k < SAMPLES; k++)); do
  src="${all[$(( (k * (n - 1)) / (SAMPLES > 1 ? SAMPLES - 1 : 1) ))]}"
  clip="$work/clip$(printf '%02d' $((k + 1))).mkv"
  # Stream copy (no re-encode) of the first CLIP_SECONDS; skip files FFmpeg cannot read.
  if nice -n 19 "$FFMPEG" -hide_banner -nostdin -loglevel error -y -t "$CLIP_SECONDS" -i "$src" \
       -map 0:v:0 -map 0:a:0? -c copy "$clip" 2>/dev/null && [ -s "$clip" ]; then
    clips+=("$clip")
  fi
done
[ "${#clips[@]}" -gt 0 ] || die "no readable sources"
echo "[enc1] ${#clips[@]} clips ready; encoding (this takes a while)"

# --- bench -------------------------------------------------------------------
nice -n 19 ionice -c3 "$work/quality-bench" -encoder "$ENCODER" -anonymize \
  -ffmpeg "$FFMPEG" -ffprobe "$FFPROBE" -vmaf-ffmpeg "$VMAF_DIR/bin/ffmpeg" \
  -settings "$SETTINGS" -work "$work/bench" -json "$out/bench.json" \
  "${clips[@]}" > "$out/bench.md" 2> "$out/bench.log"

nvidia-smi --query-gpu=name,driver_version --format=csv,noheader > "$out/gpu.txt" 2>/dev/null || true
"$FFMPEG" -hide_banner -version 2>/dev/null | sed -n 1p > "$out/ffmpeg.txt" || true

echo
cat "$out/bench.md"
echo
echo "[enc1] results: $out/bench.md (post it on GitHub: issue [ENC1] NVENC bench)"
