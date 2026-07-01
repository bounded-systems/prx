#!/usr/bin/env bash
# SessionStart hook — ensure the per-repo beadsd daemon is running so
# `prx beads <ready|list|show|update|...>` is reachable in every worktree session.
#
# prx retired host-side beadsd auto-start (prx-82b Slice 2e.4): the *pod* is meant
# to own beadsd, but pods aren't wired up yet — so this hook is the local bridge.
# It starts `prx beads serve` at the socket the client DERIVES
# (<git-common-dir>/.beads/dolt-server.sock — see client-factory.ts) against the
# canonical clone (~/.local/state/prx/beads). git-common-dir is shared across all
# worktrees, so one daemon serves them all (one daemon = one repo, GH-296).
#
# Fail OPEN + idempotent + NON-BLOCKING: if the daemon is already up it no-ops;
# otherwise it starts detached and returns immediately. Anything that goes wrong
# yields no daemon, never a blocked or slowed session.
set -uo pipefail

command -v prx >/dev/null 2>&1 || exit 0
command -v git >/dev/null 2>&1 || exit 0

git_common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
[ -n "$git_common" ] || exit 0
beads_dir="$git_common/.beads"
sock="$beads_dir/dolt-server.sock"
pidf="$beads_dir/beadsd.pid"

# Already up? The daemon writes its pid while listening, removes it on close
# (GH-223). A live pid ⇒ nothing to do.
if [ -f "$pidf" ]; then
  pid="$(cat "$pidf" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    exit 0
  fi
fi

# The clone the daemon serves — decoupled from the worktree (GH-296), mirroring
# resolveLocalBeadsCwd: PRX_BEADS_CWD override → canonical clone → repo root.
canon="${PRX_BEADS_CWD:-}"
if [ -z "$canon" ]; then
  if [ -d "$HOME/.local/state/prx/beads/.beads" ]; then
    canon="$HOME/.local/state/prx/beads"
  else
    canon="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  fi
fi
[ -n "$canon" ] || exit 0

mkdir -p "$beads_dir" 2>/dev/null || exit 0
rm -f "$sock" 2>/dev/null || true   # clear a stale socket left by a dead daemon

# Start detached; never block session start. The hook's env already carries the
# nix PATH (prx resolved above), which the daemon inherits for bd/dolt.
log="${TMPDIR:-/tmp}/prx-beadsd.log"
nohup prx beads serve --socket "$sock" --cwd "$canon" --pidfile "$pidf" \
  >>"$log" 2>&1 </dev/null &
disown 2>/dev/null || true

exit 0
