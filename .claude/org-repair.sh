#!/usr/bin/env bash
# bounded-systems org bootstrap check/repair — the org CLAUDE.md step-1 block
# as a committed file, so .claude/settings.json can pre-approve exactly this
# invocation: `bash .claude/org-repair.sh` (#491). Canonical logic lives in
# bounded-systems/.github-private CLAUDE.md; adopt-claude-harness keeps this
# copy in sync. Verifies every byte against a RESOLVED digest and REFUSES rather
# than running anything unverified.
#
# THE DIGEST SOURCE CHANGED, AND THIS SCRIPT WAS INERT FLEET-WIDE UNTIL IT WAS
# FIXED (2026-08-17, .github-private#534/#581). It used to REQUIRE
# $ORG_BOOT_SHA256 and exit 0 with "not a bounded-systems cloud session" when it
# was unset. That variable was RETIRED OUTRIGHT on 2026-08-16 evening
# (.github#192): the boot digest now rides the channel manifest, written only by
# the OIDC-pinned boot-manifest lane on main, and the front-desk dialog is down
# to a single variable (BS_ROUTES_CONFIG). Measured 2026-08-17 from a live
# front-desk session whose dialog matches the recorded union exactly: the dialog
# carries BS_ROUTES_CONFIG and nothing else, ORG_BOOT_SHA256 is unset, and this
# script printed "not a bounded-systems cloud session; nothing to do" and
# installed nothing — in a session that was exactly that. It exited 0 while
# doing so, so the failure was SILENT and every adopter had a dead step 1.
#
# The resolution order below matches CLAUDE.md's step-1 block, which was already
# corrected: legacy $ORG_BOOT_SHA256 honored first WHILE IT EXISTS, otherwise the
# channel manifest. With neither resolvable it refuses rather than falling
# through to an unverified file — `bash` only ever runs bytes that hashed to the
# resolved digest.
set -uo pipefail
R="${CLAUDE_SESSION_ROOT:-}"                     # resolve the checkout root — never assume /home/user
[ -f "$R/.github/.claude/boot.sh" ] || R="$PWD"
[ -f "$R/.github/.claude/boot.sh" ] || R="${PWD%/*}"
[ -f "$R/.github/.claude/boot.sh" ] || R=/home/user
C="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
if cmp -s "$C/stop-hook-git-check.sh" "$R/.github/.claude/stop-hook-git-check.sh"; then
  echo "bootstrap in effect"
  exit 0
fi
F="curl -fsSL --retry 3 --retry-connrefused --retry-max-time 60 --connect-timeout 5 --max-time 30"
# Legacy variable first while it still exists anywhere, then the channel
# manifest (.github#192). The manifest is written only by the OIDC-pinned
# boot-manifest lane on main, so it is a trust source, not a convenience.
S="${ORG_BOOT_SHA256:-$($F https://boot.bounded.tools/channel/front-desk.json 2>/dev/null \
  | sed -n 's/.*"boot":"\([0-9a-f]\{64\}\)".*/\1/p')}"
# The attached checkout is tried BEFORE the network on purpose: the repair must
# work when egress is down, which is exactly when a resumed session is most
# likely to be repairing by hand.
B="$R/.github/.claude/boot.sh"
{ [ -n "$S" ] && echo "$S  $B" | sha256sum -c --status - 2>/dev/null; } || {
  B=""
  [ -n "$S" ] && $F "https://boot.bounded.tools/$S.sh" -o /tmp/boot.sh \
    && echo "$S  /tmp/boot.sh" | sha256sum -c --status - && B=/tmp/boot.sh; }
if [ -n "$B" ]; then
  CLAUDE_SESSION_ROOT="$R" bash "$B"
  D="$R/.github/.claude/session-start-dispatch.mjs"
  [ -f "$D" ] || D=/opt/bounded-boot/session-start-dispatch.mjs
  CLAUDE_SESSION_ROOT="$R" node "$D"
else
  echo "org-repair: REFUSED — no verified copy (no digest source, or no bytes matched); installing nothing"
  exit 1
fi
