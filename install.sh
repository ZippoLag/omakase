#!/usr/bin/env bash
#
# omakase — build, install from scratch, and/or update.
#
# One command for every setup task the repo needs:
#   • update the source tree (git pull) unless the repo was just cloned
#   • switch to (and set as the nvm default) the pinned Node for this repo
#   • install/refresh dependencies (pnpm via corepack)
#   • build the offline dictionary (dist/kanji.db) from pinned, sha256-verified
#     sources, cached in data/raw/
#   • expose the `omakase` command on your PATH (global pnpm bin symlink)
#   • verify the toolchain: typecheck + conjugation validation + the test suite
#
# The native better-sqlite3 binding only supports Node 20–22 (the pin in
# .nvmrc), so the script switches your shell onto the pinned Node and sets it
# as the nvm default, ensuring `omakase` and `pnpm` commands work in every
# shell without manual `nvm use`.
#
# Usage:
#   ./install.sh               install or update everything
#   ./install.sh --force-db    re-download dictionary sources and rebuild the DB
#   ./install.sh --no-db       skip the database build
#   ./install.sh --no-pull     skip `git pull` (fresh checkout or offline)
#   ./install.sh --no-verify   skip typecheck / validate / test
#   ./install.sh --help        show this help
#
# Idempotent — safe to re-run any time to update an existing setup.

set -euo pipefail

FORCE_DB=false
NO_DB=false
NO_PULL=false
NO_VERIFY=false

usage() {
  sed -n '/^# omakase — build/,/^# Idempotent/p' "${BASH_SOURCE[0]}" | sed 's|^# \{0,1\}||'
}

for arg in "$@"; do
  case "$arg" in
    --force-db)  FORCE_DB=true ;;
    --no-db)     NO_DB=true ;;
    --no-pull)   NO_PULL=true ;;
    --no-verify) NO_VERIFY=true ;;
    --help|-h)   usage; exit 0 ;;
    *)
      echo "install.sh: unknown argument: $arg" >&2
      echo "Run ./install.sh --help for usage." >&2
      exit 2
      ;;
  esac
done

# Repo root = the directory holding this script. Refuse to run from an
# accidental copy that isn't a git checkout of the project.
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd "$ROOT"

if [[ ! -f package.json || ! -f pnpm-lock.yaml ]]; then
  echo "install.sh: this script lives outside the omakase checkout (no package.json/pnpm-lock.yaml)." >&2
  echo "Run it from the repository root, e.g. from a clone of the omakase repo." >&2
  exit 1
fi

log() { printf '\n==> %s\n' "$*"; }
NVM_SH="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
load_nvm() {
  [[ -s "$NVM_SH" ]] && { # shellcheck disable=SC1090
    . "$NVM_SH"
  }
}

# --- 1. Node version -----------------------------------------------------
# better-sqlite3's native binding crashes on GC under Node 24+, so the project
# must run on the pinned version from .nvmrc. Switch to it and set it as the
# nvm default so every shell (not just this script) uses it.
ensure_node() {
  log "checking Node version"
  local pinned wanted current
  wanted=$(cat .nvmrc)
  pinned=$(printf '%s' "$wanted" | sed 's/\..*//')
  current=$(node -v 2>/dev/null | sed 's/^v//' | sed 's/\..*//' || true)

  if ! command -v node >/dev/null 2>&1; then
    if [[ -s "$NVM_SH" ]]; then
      load_nvm
    else
      echo "Node not found. Install Node $wanted (nvm recommended) and re-run." >&2
      exit 1
    fi
  fi

  if [[ -n "$current" && "$current" != "$pinned" ]]; then
    if [[ -s "$NVM_SH" ]]; then
      load_nvm
      echo "switching to Node $wanted (active is v$(node -v | sed 's/^v//'))"
      nvm use "$wanted" >&2
      REBUILD_NATIVE=true
    else
      echo "Active Node is v$current, but omakase requires $wanted." >&2
      echo "Switch to Node $wanted (e.g. 'nvm use') and re-run, or set NVM_DIR." >&2
      exit 1
    fi
  fi
  echo "using Node $(node -v)"

  # Make the pinned version the nvm default so interactively-launched shells
  # (and the installed `omakase` command) pick it up too.
  if [[ -s "$NVM_SH" ]]; then
    load_nvm
    local def
    def=$(nvm alias default 2>/dev/null | sed 's/.*-> *//' | sed 's/ (.*//' || true)
    if [[ -z "${def:-}" || "$def" != "$wanted" ]]; then
      log "setting nvm default to Node $wanted"
      nvm alias default "$wanted" >/dev/null 2>&1 || true
    fi
  fi
}

# --- 2. pnpm via corepack ------------------------------------------------
# package.json pins pnpm@11.1.2 in `packageManager`; corepack supplies it.
ensure_pnpm() {
  log "ensuring pnpm (corepack)"
  local hascorepack
  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
    hascorepack=1
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    if [[ -n "${hascorepack:-}" ]]; then
      corepack use "$(node -p "require('./package.json').packageManager.split('@')[0] + '@' + require('./package.json').packageManager.split('@')[1]")" >&2
    else
      echo "pnpm unavailable and corepack is missing. Install corepack or pnpm and re-run." >&2
      exit 1
    fi
  fi
  echo "using $(pnpm --version 2>/dev/null || echo pnpm)"
}

# --- 3. Pull latest sources ----------------------------------------------
update_tree() {
  if [[ "$NO_PULL" == true ]]; then
    log "skipping git pull (--no-pull)"; return
  fi
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    log "not a git checkout — skipping git pull"; return
  fi
  local ahead remote
  remote=$(git remote 2>/dev/null | head -n1 || true)
  if [[ -z "$remote" ]]; then
    log "no git remote — skipping git pull"; return
  fi
  ahead=$(git rev-list --count "@{upstream}"..HEAD 2>/dev/null || echo 0)
  if [[ "$ahead" != "0" ]]; then
    log "local commits ahead of origin — skipping git pull to avoid conflicts"; return
  fi
  log "pulling latest from origin/$remote"
  git pull --ff-only || {
    echo "git pull failed — resolve conflicts/upstream and re-run." >&2
    exit 1
  }
}

# --- 4. Install dependencies ---------------------------------------------
install_deps() {
  log "installing dependencies (pnpm install)"
  pnpm install
  # If we switched Node above the previous native binding is stale; rebuild it
  # so better-sqlite3 matches the runtime.
  if [[ "${REBUILD_NATIVE:-false}" == true ]]; then
    log "rebuilding better-sqlite3 for the current Node"
    pnpm rebuild better-sqlite3
  fi
}

# --- 5. Build the offline database ---------------------------------------
build_db() {
  if [[ "$NO_DB" == true ]]; then
    log "skipping database build (--no-db)"
    return
  fi
  log "building dictionary database"
  if [[ "$FORCE_DB" == true ]]; then
    pnpm run build:db -- --force
  else
    pnpm run build:db
  fi
}

# --- 6. Expose the command globally --------------------------------------
link_global() {
  log "linking 'omakase' onto your PATH"
  pnpm run link:global
}

# --- 7. Install the version-bump git hook ---------------------------------
# The pre-commit hook re-stamps src/version.ts so the version number bumps on
# every commit (scripts/version.mjs). core.hooksPath keeps the hook under
# version control instead of the non-shared .git/hooks/ directory.
install_hooks() {
  log "installing git hooks (core.hooksPath → .githooks)"
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git config core.hooksPath .githooks
    chmod +x .githooks/pre-commit 2>/dev/null || true
    echo "installed: .githooks/pre-commit (bumps the version on every commit)"
  else
    echo "not a git checkout — skipping hooks"
  fi
}

# --- 8. Smoke test -------------------------------------------------------
smoke_test() {
  log "verifying install"
  if command -v omakase >/dev/null 2>&1; then
    omakase --help >/dev/null 2>&1 && echo "ok: omakase --help"
  else
    echo "note: installed script not found on PATH" >&2
  fi
  if [[ "$NO_DB" != true ]] && [[ -f dist/kanji.db ]]; then
    if command -v omakase >/dev/null 2>&1 && omakase word 食べる >/dev/null 2>&1; then
      echo "ok: omakase word 食べる"
    fi
  fi
}

# --- 8. Verify the dev toolchain (typecheck / validate / tests) ----------
verify_dev() {
  if [[ "$NO_VERIFY" == true ]]; then
    log "skipping dev checks (--no-verify)"
    return
  fi
  log "verifying dev toolchain — typecheck, validate, tests"
  pnpm run typecheck
  pnpm run validate:conjugations >/dev/null
  pnpm test
  echo "dev checks: all passed"
}

ensure_node
ensure_pnpm
update_tree
install_deps
build_db
link_global
install_hooks
pinned_node=$(cat .nvmrc)

smoke_test
verify_dev

cat <<EOF

omakase is installed and up to date.
  • command:        omakase --help / omakase --version
  • database:       dist/kanji.db
  • nvm default:    $pinned_node
  • git hooks:      core.hooksPath → .githooks (version bumps per commit)
  • dev checks:     typecheck / validate / test all passed
Re-run ./install.sh any time to refresh (git pull → install → rebuild DB →
verify). To cleanly reset first, run ./uninstall.sh (add --purge to also drop
the downloaded dictionary sources), then ./install.sh again.
EOF