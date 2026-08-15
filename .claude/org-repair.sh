#!/usr/bin/env bash
# bounded-systems org bootstrap check/repair — the org CLAUDE.md step-1 block
# as a committed file, so .claude/settings.json can pre-approve exactly this
# invocation: `bash .claude/org-repair.sh` (#491). Canonical logic lives in
# bounded-systems/.github-private CLAUDE.md; adopt-claude-harness keeps this
# copy in sync. Verifies every byte against the dialog-recorded
# $ORG_BOOT_SHA256 and REFUSES rather than running anything unverified.
set -uo pipefail
[ -n "${ORG_BOOT_SHA256:-}" ] || {
  echo "org-repair: ORG_BOOT_SHA256 unset — not a bounded-systems cloud session; nothing to do"
  exit 0
}
R="${CLAUDE_SESSION_ROOT:-}"                     # resolve the checkout root — never assume /home/user
[ -f "$R/.github/.claude/boot.sh" ] || R="$PWD"
[ -f "$R/.github/.claude/boot.sh" ] || R="${PWD%/*}"
[ -f "$R/.github/.claude/boot.sh" ] || R=/home/user
C="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
if cmp -s "$C/stop-hook-git-check.sh" "$R/.github/.claude/stop-hook-git-check.sh"; then
  echo "bootstrap in effect"
  exit 0
fi
B="$R/.github/.claude/boot.sh"   # attached checkout — same bytes, no egress
echo "$ORG_BOOT_SHA256  $B" | sha256sum -c --status - 2>/dev/null || {
  B=""
  curl -fsSL --retry 3 --retry-connrefused --retry-max-time 60 --connect-timeout 5 \
    --max-time 30 "https://boot.bounded.tools/$ORG_BOOT_SHA256.sh" -o /tmp/boot.sh \
    && echo "$ORG_BOOT_SHA256  /tmp/boot.sh" | sha256sum -c --status - && B=/tmp/boot.sh; }
if [ -n "$B" ]; then
  CLAUDE_SESSION_ROOT="$R" bash "$B"
  D="$R/.github/.claude/session-start-dispatch.mjs"
  [ -f "$D" ] || D=/opt/bounded-boot/session-start-dispatch.mjs
  CLAUDE_SESSION_ROOT="$R" node "$D"
else
  echo "org-repair: REFUSED — no copy matched \$ORG_BOOT_SHA256; installing nothing"
  exit 1
fi