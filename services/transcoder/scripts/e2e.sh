#!/usr/bin/env bash
# End-to-end check of the upload → transcode pipeline against a running stack:
# create an upload through the API, PUT every part to the presigned URLs with
# curl, complete it, then poll until the video is READY (or FAILED / timeout).
#
# Requires: bash, curl, jq. ffmpeg only when FILE is not given (a test clip is
# generated) or when MEDIA_BASE is set (the published master is probed).
#
# Environment:
#   API_BASE      base URL of the API           (default http://localhost:8080)
#   AUTH_TOKEN    bearer token; the gateway then sets the identity headers
#   USER_ID       when talking to upload-svc directly (no gateway): X-User-Id
#   USER_ROLES    X-User-Roles for direct calls  (default "viewer,creator")
#   FILE          video to upload                (default: generated 30 s 1080p clip)
#   TITLE         video title                    (default "e2e <timestamp>")
#   TIMEOUT_SEC   how long to wait for READY     (default 900)
#   MEDIA_BASE    e.g. https://media.winkey.vn; if set, the master playlist is
#                 fetched and ffprobe'd after READY
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:8080}"
USER_ROLES="${USER_ROLES:-viewer,creator}"
TIMEOUT_SEC="${TIMEOUT_SEC:-900}"
TITLE="${TITLE:-e2e $(date -u +%Y-%m-%dT%H:%M:%SZ)}"

for bin in curl jq; do command -v "$bin" >/dev/null || { echo "missing dependency: $bin" >&2; exit 2; }; done

auth=()
if [[ -n "${AUTH_TOKEN:-}" ]]; then
  auth=(-H "Authorization: Bearer ${AUTH_TOKEN}")
elif [[ -n "${USER_ID:-}" ]]; then
  auth=(-H "X-User-Id: ${USER_ID}" -H "X-User-Roles: ${USER_ROLES}")
else
  echo "set AUTH_TOKEN (through the gateway) or USER_ID (direct to upload-svc)" >&2; exit 2
fi

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

FILE="${FILE:-}"
if [[ -z "$FILE" ]]; then
  command -v ffmpeg >/dev/null || { echo "set FILE or install ffmpeg to generate a clip" >&2; exit 2; }
  FILE="$tmp/clip.mp4"
  echo "generating test clip…"
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i testsrc2=size=1920x1080:rate=30 -f lavfi -i sine=frequency=440 \
    -t 30 -c:v libx264 -preset ultrafast -c:a aac -shortest "$FILE"
fi
size="$(wc -c < "$FILE" | tr -d ' ')"
echo "file: $FILE ($size bytes)"

api() { # api METHOD PATH [JSON]  → prints body, fails on HTTP >= 400
  local method="$1" path="$2" body="${3:-}" out="$tmp/resp" code
  local args=(-sS -o "$out" -w '%{http_code}' -X "$method" "${auth[@]}" "${API_BASE}${path}")
  [[ -n "$body" ]] && args+=(-H 'Content-Type: application/json' -d "$body")
  code="$(curl "${args[@]}")"
  if (( code >= 400 )); then echo "HTTP $code from $method $path: $(cat "$out")" >&2; return 1; fi
  cat "$out"
}

echo "creating upload…"
create="$(api POST /v1/uploads "$(jq -n --arg t "$TITLE" --arg n "$(basename "$FILE")" --argjson s "$size" \
  '{title:$t, filename:$n, content_type:"video/mp4", size_bytes:$s}')")"
video_id="$(jq -r .video_id <<<"$create")"
part_size="$(jq -r .part_size <<<"$create")"
part_count="$(jq -r .part_count <<<"$create")"
echo "video_id=$video_id part_size=$part_size part_count=$part_count"
(( part_size % 1048576 == 0 )) || { echo "part_size is not a whole MiB" >&2; exit 1; }
part_mib=$(( part_size / 1048576 ))

parts_json='[]'
for (( first=1; first<=part_count; first+=100 )); do
  last=$(( first + 99 )); (( last > part_count )) && last=$part_count
  nums="$(seq -s, "$first" "$last")"
  presigned="$(api POST "/v1/uploads/${video_id}/parts" "{\"part_numbers\":[${nums}]}")"
  while IFS=$'\t' read -r n url; do
    skip=$(( (n - 1) * part_mib ))
    hdr="$tmp/hdr.$n"
    dd if="$FILE" bs=1048576 skip="$skip" count="$part_mib" status=none \
      | curl -sS -f -X PUT --data-binary @- -D "$hdr" -o /dev/null "$url"
    etag="$(tr -d '\r' < "$hdr" | awk -F': ' 'tolower($1)=="etag"{print $2}')"
    [[ -n "$etag" ]] || { echo "part $n: no ETag in response" >&2; exit 1; }
    parts_json="$(jq -c --argjson n "$n" --arg e "$etag" '. + [{part_number:$n, etag:$e}]' <<<"$parts_json")"
    printf '\rparts uploaded: %d/%d' "$n" "$part_count"
  done < <(jq -r '.urls[] | [.part_number, .url] | @tsv' <<<"$presigned")
done
echo

echo "completing…"
api POST "/v1/uploads/${video_id}/complete" "{\"parts\":${parts_json}}" | jq -c .

echo "waiting for READY (timeout ${TIMEOUT_SEC}s)…"
deadline=$(( $(date +%s) + TIMEOUT_SEC ))
while :; do
  st="$(api GET "/v1/uploads/${video_id}")"
  status="$(jq -r .status <<<"$st")"; progress="$(jq -r .progress <<<"$st")"
  printf '\r%-10s %5.1f%%   ' "$status" "$progress"
  case "$status" in
    READY) echo; break ;;
    FAILED) echo; echo "FAILED: $(jq -r .error <<<"$st")" >&2; exit 1 ;;
  esac
  (( $(date +%s) < deadline )) || { echo; echo "timed out waiting for READY" >&2; exit 1; }
  sleep 5
done
echo "READY: video_id=$video_id"

if [[ -n "${MEDIA_BASE:-}" ]]; then
  command -v ffprobe >/dev/null || { echo "ffprobe not installed; skipping master check" >&2; exit 0; }
  echo "checking master playlist under ${MEDIA_BASE}…"
  master="${MEDIA_BASE%/}/v/${video_id}/a1/hls/master.m3u8"
  curl -sS -f "$master" -o "$tmp/master.m3u8"
  variants="$(grep -c '^#EXT-X-STREAM-INF' "$tmp/master.m3u8")"
  echo "variants in master: $variants"
  (( variants >= 1 )) || { echo "master has no variants" >&2; exit 1; }
  ffprobe -v error -show_entries stream=codec_name,width,height -of csv=p=0 "$master" >/dev/null \
    && echo "ffprobe can read the master over HTTP"
fi
echo "e2e OK"
