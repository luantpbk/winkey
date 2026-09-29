#!/usr/bin/env bash
# install.sh: build, install, upgrade and roll back the Winkey transcoder on gpu-01 (ADR-015).
#
#   install.sh install     first install: build, link, and print the one-time root steps
#   install.sh upgrade     build the checked-out commit, switch `current` to it, print the restart
#   install.sh rollback    switch `current` back to the previous version, print the restart
#   install.sh status      versions, service state, unit and env-file checks
#
# This script never calls sudo and never touches the miner or ComfyUI. Everything it does runs as
# the invoking user inside $PREFIX. Steps that need root are PRINTED for a human to run.
#
# Layout:  $PREFIX/<git-sha>/transcoder (+ replay-dlq, VERSION)   one directory per version
#          $PREFIX/current  -> <git-sha>                           what the service runs
#          $PREFIX/previous -> <git-sha>                           what `rollback` returns to
#
# Environment (all optional):
#   WINKEY_PREFIX  install root                     (default /opt/winkey/transcoder)
#   GO             the go command                   (default: go, or /usr/local/go/bin/go)
#   VERSION_ID     name of the version directory instead of the git sha (letters, digits, . _ -)
#   ALLOW_DIRTY=1  build even with uncommitted changes (the version is then suffixed -dirty-<time>)
#   REBUILD=1      rebuild a version that is already installed
#   KEEP           how many old versions to keep    (default 5)
#   HEALTH_URL     readiness URL for `status`       (default http://127.0.0.1:8081/readyz)

set -euo pipefail

PREFIX="${WINKEY_PREFIX:-/opt/winkey/transcoder}"
KEEP="${KEEP:-5}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8081/readyz}"
SERVICE="winkey-transcoder"
UNIT_DST="/etc/systemd/system/${SERVICE}.service"
ENV_DST="/etc/winkey/transcoder.env"
SVC_USER="winkey-transcoder"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)" # services/transcoder
UNIT_SRC="${SCRIPT_DIR}/${SERVICE}.service"
ENV_SRC="${SCRIPT_DIR}/transcoder.env.example"

info() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}
# root_cmd prints a command a human must run as root; it never runs it.
root_cmd() { printf '    sudo %s\n' "$*"; }

find_go() {
  if [ -n "${GO:-}" ]; then
    printf '%s\n' "$GO"
  elif command -v go >/dev/null 2>&1; then
    command -v go
  elif [ -x /usr/local/go/bin/go ]; then
    printf '%s\n' /usr/local/go/bin/go
  else
    return 1
  fi
}

repo_root() { git -C "$MODULE_DIR" rev-parse --show-toplevel; }

# version_id: the short commit sha, suffixed when the tree has uncommitted changes.
version_id() {
  local root sha dirty
  if [ -n "${VERSION_ID:-}" ]; then
    [[ "$VERSION_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "VERSION_ID may only contain letters, digits, '.', '_' and '-'"
    printf '%s
' "$VERSION_ID"
    return 0
  fi
  root="$(repo_root)" || die "not inside a git checkout"
  sha="$(git -C "$root" rev-parse --short=12 HEAD)"
  dirty="$(git -C "$root" status --porcelain -- services/transcoder libs/go)"
  if [ -n "$dirty" ]; then
    [ "${ALLOW_DIRTY:-0}" = 1 ] || die "uncommitted changes in services/transcoder or libs/go; commit them or set ALLOW_DIRTY=1"
    sha="${sha}-dirty-$(date +%Y%m%d%H%M%S)"
  fi
  printf '%s\n' "$sha"
}

link_target() { readlink "${PREFIX}/$1" 2>/dev/null || true; }

# set_link NAME TARGET: atomically (re)point $PREFIX/NAME at the version directory TARGET.
set_link() {
  local name="$1" target="$2"
  ln -sfn "$target" "${PREFIX}/${name}.tmp"
  mv -T "${PREFIX}/${name}.tmp" "${PREFIX}/${name}"
}

require_prefix() {
  [ -d "$PREFIX" ] || {
    warn "${PREFIX} does not exist. Create it once, owned by the user who runs this script:"
    root_cmd "install -d -m 0755 -o $(id -un) -g winkey $(dirname "$PREFIX") ${PREFIX}"
    exit 1
  }
  [ -w "$PREFIX" ] || die "${PREFIX} is not writable by $(id -un)"
}

build_version() {
  local id="$1" dest="${PREFIX}/$1" tmp go_cmd
  if [ -f "${dest}/transcoder" ] && [ -f "${dest}/VERSION" ] && [ "${REBUILD:-0}" != 1 ]; then
    info "version ${id} is already installed; not rebuilding (REBUILD=1 forces it)"
    return 0
  fi
  go_cmd="$(find_go)" || die "go not found (set GO=/path/to/go)"
  tmp="${PREFIX}/.build-${id}.$$"
  rm -rf "$tmp"
  mkdir -p "$tmp"
  info "building ${id} with $("$go_cmd" version)"
  (
    cd "$MODULE_DIR"
    export CGO_ENABLED=0 GOOS=linux GOARCH=amd64
    "$go_cmd" build -trimpath -ldflags="-s -w" -o "${tmp}/transcoder" ./cmd/transcoder
    "$go_cmd" build -trimpath -ldflags="-s -w" -o "${tmp}/replay-dlq" ./cmd/replay-dlq
  ) || {
    rm -rf "$tmp"
    die "build failed"
  }

  # Smoke test: with an empty environment the worker must refuse to start with exit code 2
  # ("invalid configuration"). Anything else means this is not a working binary.
  local rc=0
  env -i "${tmp}/transcoder" >/dev/null 2>&1 || rc=$?
  if [ "$rc" -ne 2 ]; then
    rm -rf "$tmp"
    die "smoke test failed: the new binary exited with ${rc} instead of 2 on an empty environment"
  fi

  {
    printf 'version=%s\n' "$id"
    printf 'built_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'built_by=%s\n' "$(id -un)"
    printf 'commit=%s\n' "$(git -C "$MODULE_DIR" rev-parse HEAD)"
  } >"${tmp}/VERSION"
  chmod 0755 "${tmp}/transcoder" "${tmp}/replay-dlq"
  rm -rf "$dest"
  mv -T "$tmp" "$dest"
  info "installed ${dest}"
}

# activate ID: point current at ID and remember the version it replaces as previous.
activate() {
  local id="$1" old
  old="$(link_target current)"
  if [ "$old" = "$id" ]; then
    info "current already points at ${id}"
    return 0
  fi
  if [ -n "$old" ]; then
    set_link previous "$old"
  fi
  set_link current "$id"
  info "current  -> ${id}"
  if [ -n "$old" ]; then
    info "previous -> ${old}"
  fi
}

# versions_newest_first prints the installed version directory names, newest first.
versions_newest_first() {
  find "$PREFIX" -mindepth 1 -maxdepth 1 -type d ! -name '.build-*' -printf '%T@ %f
' 2>/dev/null |
    sort -rn | cut -d' ' -f2-
}

# prune: delete old version directories, keeping current, previous and the newest $KEEP.
prune() {
  local keep_names name n=0
  keep_names=" $(link_target current) $(link_target previous) "
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    n=$((n + 1))
    if [ "$n" -le "$KEEP" ] || [[ "$keep_names" == *" ${name} "* ]]; then
      continue
    fi
    info "removing old version ${name}"
    rm -rf "${PREFIX:?}/${name}"
  done < <(versions_newest_first)
}

restart_hint() {
  info ""
  info "Restart the service to run the new version (safe at any time: running jobs get their"
  info "grace period, then go back to the queue; see README.md):"
  root_cmd "systemctl restart ${SERVICE}"
  info "Then check it:"
  info "    $0 status"
  info "    journalctl -u ${SERVICE} -o cat -n 30"
}

unit_hint() {
  if [ ! -f "$UNIT_DST" ]; then
    return 0
  fi
  if ! cmp -s "$UNIT_SRC" "$UNIT_DST"; then
    info ""
    info "The installed unit differs from this checkout. Review it, then install it:"
    info "    diff ${UNIT_DST} ${UNIT_SRC}"
    root_cmd "install -m 0644 ${UNIT_SRC} ${UNIT_DST}"
    root_cmd "systemctl daemon-reload"
  fi
}

# print_setup: the one-time steps that need root, only those that are not done yet.
print_setup() {
  local pending=0
  info ""
  info "One-time setup that needs root (run these yourself; steps already done are omitted):"
  info ""
  if ! id "$SVC_USER" >/dev/null 2>&1; then
    pending=1
    info "  1. the service user (groups video and render give access to /dev/nvidia*, winkey owns the"
    info "     scratch and archive directories):"
    info "       check the groups exist:  getent group video render winkey"
    root_cmd "useradd --system --user-group --no-create-home --shell /usr/sbin/nologin --groups video,render,winkey ${SVC_USER}"
  fi
  if [ ! -f "$ENV_DST" ]; then
    pending=1
    info "  2. the environment file (credentials; fill in the real values, keep it root:root 0600):"
    root_cmd "install -d -m 0755 /etc/winkey"
    root_cmd "install -m 0600 -o root -g root ${ENV_SRC} ${ENV_DST}"
    root_cmd "sudoedit ${ENV_DST}"
  fi
  if [ ! -f "$UNIT_DST" ]; then
    pending=1
    info "  3. the unit:"
    root_cmd "install -m 0644 ${UNIT_SRC} ${UNIT_DST}"
    root_cmd "systemctl daemon-reload"
    root_cmd "systemd-analyze verify ${UNIT_DST}"
  fi
  if ! systemctl is-enabled --quiet "$SERVICE" 2>/dev/null; then
    pending=1
    info "  4. start it (after the env file holds real values) and enable it at boot:"
    root_cmd "systemctl enable --now ${SERVICE}"
  fi
  if [ "$pending" -eq 0 ]; then
    info "  (nothing left to do: user, env file, unit and service are all in place)"
  fi
  info ""
  info "Scratch and archive must be writable by the service user (via group winkey); check with:"
  info "    grep -E '^(SCRATCH_DIR|ARCHIVE_DIR)=' ${ENV_DST}   # as root, then:"
  root_cmd "-u ${SVC_USER} test -w /mnt/nvme_models/winkey/scratch && echo scratch ok"
}

cmd_install() {
  require_prefix
  local id
  id="$(version_id)"
  build_version "$id"
  activate "$id"
  prune
  print_setup
}

cmd_upgrade() {
  require_prefix
  [ -n "$(link_target current)" ] || die "nothing is installed yet; run: $0 install"
  local id
  id="$(version_id)"
  build_version "$id"
  activate "$id"
  prune
  unit_hint
  restart_hint
}

cmd_rollback() {
  require_prefix
  local cur prev
  cur="$(link_target current)"
  prev="$(link_target previous)"
  [ -n "$prev" ] || die "there is no previous version to roll back to"
  [ -f "${PREFIX}/${prev}/transcoder" ] || die "the previous version ${prev} is no longer installed"
  # Swap, so running rollback twice toggles between the two versions.
  set_link previous "$cur"
  set_link current "$prev"
  info "current  -> ${prev}"
  info "previous -> ${cur}"
  restart_hint
}

cmd_status() {
  local cur prev name marks
  cur="$(link_target current)"
  prev="$(link_target previous)"
  info "prefix:   ${PREFIX}"
  info "current:  ${cur:-none}"
  info "previous: ${prev:-none}"
  info "installed versions (newest first):"
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    marks=""
    [ "$name" = "$cur" ] && marks="${marks} <- current"
    [ "$name" = "$prev" ] && marks="${marks} <- previous"
    info "  ${name}${marks}"
  done < <(versions_newest_first)
  if [ -n "$cur" ] && [ -f "${PREFIX}/${cur}/VERSION" ]; then
    info "current build:"
    sed 's/^/  /' "${PREFIX}/${cur}/VERSION"
  fi
  info ""
  if command -v systemctl >/dev/null 2>&1; then
    info "service:  active=$(systemctl is-active "$SERVICE" 2>/dev/null || true) enabled=$(systemctl is-enabled "$SERVICE" 2>/dev/null || true)"
    systemctl show "$SERVICE" -p MainPID -p NRestarts -p ActiveEnterTimestamp 2>/dev/null | sed 's/^/  /' || true
  fi
  if id "$SVC_USER" >/dev/null 2>&1; then
    info "user:     $(id "$SVC_USER")"
  else
    info "user:     ${SVC_USER} does not exist yet"
  fi
  if [ -f "$UNIT_DST" ]; then
    if cmp -s "$UNIT_SRC" "$UNIT_DST"; then
      info "unit:     installed, identical to this checkout"
    else
      info "unit:     installed, DIFFERS from this checkout (see: $0 upgrade)"
    fi
  else
    info "unit:     not installed"
  fi
  if [ -e "$ENV_DST" ]; then
    info "env file: $(stat -c '%U:%G %a' "$ENV_DST" 2>/dev/null || echo present) ${ENV_DST} (expected root:root 600)"
  else
    info "env file: missing (${ENV_DST})"
  fi
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null; then
      info ""
    else
      info "health:   ${HEALTH_URL} did not answer (service stopped, or HTTP_ADDR differs: set HEALTH_URL)"
    fi
  fi
}

usage() {
  sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

case "${1:-}" in
install) cmd_install ;;
upgrade) cmd_upgrade ;;
rollback) cmd_rollback ;;
status) cmd_status ;;
-h | --help | help | "") usage ;;
*)
  usage >&2
  exit 2
  ;;
esac
