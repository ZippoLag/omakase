#!/usr/bin/env bash
#
# omakase — uninstall / clean reset. Reverts everything ./install.sh creates,
# so a fresh `./install.sh` afterwards yields a clean, working setup.
#
# What it removes:
#   • the `omakase` command from your PATH (pnpm global-bin symlink + pnpm link)
#   • node_modules/ (the dependency install, incl. the native better-sqlite3
#     build, which is tied to a specific Node version — removing it guarantees
#     a correct rebuild for the pinned Node on the next install)
#   • dist/ (the built dictionary database and metadata)
#   • (optional) data/raw/ — the cached dictionary sources, with --purge
#
# Usage:
#   ./uninstall.sh        remove the global command, node_modules, and dist/
#   ./uninstall.sh --purge  also delete the downloaded dictionary sources
#   ./uninstall.sh --help   show this help
#
set -euo pipefail

PURGE=false

usage() {
  sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's|^# \{0,1\}||'
}

for arg in "$@"; do
  case "$arg" in
    --purge)  PURGE=true ;;
    --help|-h) usage; exit 0 ;;
    *)
      echo "uninstall.sh: unknown argument: $arg" >&2
      echo "Run ./uninstall.sh --help for usage." >&2
      exit 2
      ;;
  esac
done

# Repo root = the directory holding this script. Refuse to run from an
# accidental copy that isn't a checkout of the project.
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd "$ROOT"

if [[ ! -f package.json || ! -f pnpm-lock.yaml ]]; then
  echo "uninstall.sh: this script lives outside the omakase checkout (no package.json/pnpm-lock.yaml)." >&2
  echo "Run it from the repository root." >&2
  exit 1
fi

log() { printf '\n==> %s\n' "$*"; }

# --- 1. Unlink the global `omakase` command ------------------------------
unlink_global() {
  log "unlinking the global 'omakase' command"
  # `pnpm bin -g` may print a warning before the path; take the last line.
  local global_bin link
  global_bin=$(pnpm bin -g 2>/dev/null | sed '/^[[:space:]]*$/d' | tail -n1) || true
  if [[ -n "$global_bin" ]]; then
    link="$global_bin/omakase"
    if [[ -L "$link" || -e "$link" ]]; then
      rm -f -- "$link"
      echo "removed: $link"
    else
      echo "no symlink at $link — nothing to unlink"
    fi
  fi

  # Ask pnpm to drop any global register of the package too (harmless if none).
  if pnpm ls -g --depth -1 omakase >/dev/null 2>&1; then
    pnpm unlink --global omakase >/dev/null 2>&1 || true
  fi
  echo "done"
}

# --- 2. Remove node_modules (dependency install + native build) -----------
remove_node_modules() {
  if [[ -d node_modules ]]; then
    log "removing node_modules/ ($(du -sh node_modules 2>/dev/null | awk '{print $1}' || echo '?'))"
    rm -rf -- node_modules
    echo "removed node_modules/"
  else
    log "node_modules/ not present"
  fi
}

# --- 3. Remove the build ---------------------------------------------------
remove_build() {
  if [[ -d dist ]]; then
    log "removing dist/ ($(du -sh dist 2>/dev/null | awk '{print $1}' || echo '?'))"
    rm -rf -- dist
    echo "removed dist/"
  else
    log "dist/ not present"
  fi
}

# --- 4. Optionally purge downloaded sources --------------------------------
purge_sources() {
  if [[ "$PURGE" != true ]]; then
    log "keeping data/raw/ (dictionary sources cache); use --purge to delete it"
    return
  fi
  if [[ -d data/raw ]]; then
    log "removing data/raw/ ($(du -sh data/raw 2>/dev/null | awk '{print $1}' || echo '?'))"
    rm -rf -- data/raw
    echo "removed data/raw/"
  else
    log "data/raw/ not present"
  fi
}

sources_note=$([ "$PURGE" = true ] && echo removed || echo kept)

unlink_global
remove_node_modules
remove_build
purge_sources

cat <<EOF

omakase has been uninstalled and cleaned up.
  • command:        removed from PATH
  • node_modules/:  removed
  • dist/ (build):  removed
  • data/raw/ (sources): $sources_note
Re-run ./install.sh to build, install, and link everything from scratch.
EOF