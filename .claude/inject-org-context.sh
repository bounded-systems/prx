#!/usr/bin/env bash
# SessionStart hook — inject the bounded-systems canonical Claude context.
# Canonical source since .github#175: bounded-systems/.github -> claude/context.md
# (PUBLIC — the #491 audit found nothing private; the .github-private copy is a
# duplicate that remains a fallback below). Since infra#415 that public copy is
# reached through boot.bounded.tools/public-context.md rather than raw
# .githubusercontent.com — same bytes, one fewer host a session must reach. See
# step 0.
#
# THE TWO COPIES ARE NOT GUARANTEED IDENTICAL, and this header used to say they
# were "byte-identical until #494 retires it". Both halves were wrong (#581):
# #494 is a different subject (it retired PATHBASE_LEASE_KEY, closed 2026-08-16),
# and the copies diverged on 2026-08-15 when 50bc53d taught the three-door claim
# ladder in .github-private and never propagated here. For two days every session
# in the fleet was injected the OLD single-door convention — the one keycard#7
# proved unsound and #530 built claim-relay.yml to displace — because step 0
# below fetches THIS repo's copy and it was the stale one.
#
# A comment asserting an invariant is not a check (agentic-code-hygiene rule 3).
# So this script no longer assumes it: step L prefers a local checkout when the
# session has one, and SAYS SO OUT LOUD when two local copies disagree, which is
# the only moment a session can notice the drift that affects it.
# Fail OPEN but never SILENT: anything that goes wrong yields no context and one
# status line saying so — a degraded session must be able to tell (#491).
set -uo pipefail
command -v jq >/dev/null 2>&1 || exit 0

path='repos/bounded-systems/.github-private/contents/claude/context.md'
ctx=""

# L) THE LOCAL CHECKOUT, when the session has one. Tried before any network
#    source because a fetched copy can be OLDER than the tree the session was
#    created from, and on 2026-08-15 it was: this session's own correct
#    context.md sat two directories away on disk while step 0 pulled the stale
#    one over the wire (#581). A session should not be taught a convention its
#    own checkout contradicts.
#
#    Root resolution mirrors org-repair.sh's, deliberately — never assume
#    /home/user. .github-private is preferred when both are present because it
#    is the copy boot-deploy.yml publishes into CONTEXT_KV, and empirically the
#    one that gets maintained first.
#
#    When both exist and DIFFER, that is the #581 defect recurring, and it is
#    reported rather than silently resolved: the elected copy still loads (a
#    session with context beats one without), but the divergence is named in
#    the injected text so whoever reads it can see the org is inconsistent.
R="${CLAUDE_SESSION_ROOT:-}"
[ -f "$R/.github/.claude/boot.sh" ] 2>/dev/null || R="$PWD"
[ -f "$R/.github/.claude/boot.sh" ] || R="${PWD%/*}"
[ -f "$R/.github/.claude/boot.sh" ] || R=/home/user
priv="$R/.github-private/claude/context.md"
pub="$R/.github/claude/context.md"
drift=""
if [ -f "$priv" ] && [ -f "$pub" ] && ! cmp -s "$priv" "$pub"; then
  drift="⚠ org context DRIFT: ${priv} and ${pub} differ. Using the .github-private copy. The .github copy is what a session WITHOUT a checkout is served, so bare sessions are getting the other text — see .github-private#581."
fi
if [ -f "$priv" ]; then
  ctx="$(cat "$priv" 2>/dev/null || true)"
elif [ -f "$pub" ]; then
  ctx="$(cat "$pub" 2>/dev/null || true)"
fi

# 0) The public canonical copy — anonymous, no token, no clone. This is the
#    source that works in a cloud session with NOTHING attached; every fallback
#    below was measured failing there on 2026-07-31, when the file lived only in
#    the private repo.
#
#    SERVED THROUGH THE BOOT WORKER since infra#415, not fetched from
#    raw.githubusercontent.com directly. THE BYTES ARE THE SAME FILE: the Worker
#    fetches bounded-systems/.github's claude/context.md from CLOUDFLARE'S
#    network and streams it through verbatim — verified byte-identical against
#    both the checkout and the raw upstream at deploy time (all three hashed to
#    99f98f39… on 2026-08-17). What changes is only which host THIS session
#    contacts, and that is the entire point: this line was the last session-side
#    use of raw.githubusercontent.com, and the only reason that host was still in
#    the front-desk egress allowlist (.github-private#534 item 2).
#
#    NOT the Worker's /context.md — that route is lease-gated and serves the
#    .github-PRIVATE copy out of CONTEXT_KV, a different file that #581 recorded
#    diverging from this one. /public-context.md is the public copy, which is
#    what this hook has always fetched.
#
#    NO raw.githubusercontent FALLBACK is kept, deliberately. A fallback to the
#    host we are retiring would stop working the moment the allowlist entry is
#    dropped, leaving dead code that reads like resilience; and the failure it
#    would cover — the Worker being unreachable — is already covered by steps 1-3
#    over github.com, a host that is not going anywhere. Fail open, loudly, per
#    the message at the bottom.
if [ -z "$ctx" ] && command -v curl >/dev/null 2>&1; then
  ctx="$(curl -fsSL --connect-timeout 5 --max-time 15 \
    https://boot.bounded.tools/public-context.md \
    2>/dev/null || true)"
fi

# 1) gh API — local dev, or cloud only if gh is installed AND a token is present.
if [ -z "$ctx" ] && command -v gh >/dev/null 2>&1; then
  ctx="$(gh api "$path" -H 'Accept: application/vnd.github.raw' 2>/dev/null || true)"
fi

# 2) Cloud-native (Claude Code on the web): no token lives in the container and
#    gh isn't pre-installed, so clone via the GitHub proxy. Access follows the
#    session's GitHub auth — maintainers succeed, outside contributors fail open.
if [ -z "$ctx" ] && command -v git >/dev/null 2>&1; then
  d="$(mktemp -d 2>/dev/null || echo "/tmp/orgctx.$$")"
  if git clone --depth 1 --filter=blob:none --sparse \
       https://github.com/bounded-systems/.github-private.git "$d" >/dev/null 2>&1; then
    git -C "$d" sparse-checkout set claude/context.md >/dev/null 2>&1 || true
    [ -f "$d/claude/context.md" ] && ctx="$(cat "$d/claude/context.md")"
  fi
  rm -rf "$d" 2>/dev/null || true
fi

# 3) curl fallback if a PAT is provided out-of-band (e.g. GH_TOKEN in env config).
if [ -z "$ctx" ]; then
  tok="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
  if [ -n "$tok" ] && command -v curl >/dev/null 2>&1; then
    ctx="$(curl -fsSL -H "Authorization: Bearer $tok" -H 'Accept: application/vnd.github.raw' \
            "https://api.github.com/$path" 2>/dev/null || true)"
  fi
fi

# Fail OPEN but LOUD: hook stdout is injected into session context, so this one
# line is what lets a session know it is degraded — measured 2026-08-15 (#491):
# the silent variant made a context-less session indistinguishable from a
# healthy one, and the verbspec worker shipped work without knowing.
if [ -z "$ctx" ]; then
  echo "org context NOT loaded — all sources failed (boot.bounded.tools/public-context.md, gh api, git clone, curl+token). Degraded mode: see the org stanza in CLAUDE.md."
  exit 0
fi

# One session start injects this block ONCE (#508, measured 2026-08-16): the
# attached repo's own SessionStart hook and the boot-installed dispatcher both
# run this script, in separate envelopes no in-process merge can reach — so the
# second run detects the first through a short-lived marker and stays silent.
# The predicate is "already INJECTED", never "other hook installed" — installed
# is not fired (#427, #506). Keyed by session id and aged 90s: sibling hooks in
# one start fire seconds apart, while distinct starts (create → resume, or the
# snapshot's --init-only pass → the first real session) are minutes apart or
# carry a different id. Marker only on SUCCESS: a degraded run writes nothing,
# so a later sibling that can reach the context still injects it.
m="/tmp/.bounded-org-context.${CLAUDE_CODE_SESSION_ID:-any}"
now="$(date +%s)"
mt="$(stat -c %Y "$m" 2>/dev/null || stat -f %m "$m" 2>/dev/null || echo 0)"
if [ -f "$m" ] && [ $((now - mt)) -lt 90 ]; then
  exit 0
fi
touch "$m" 2>/dev/null || true
# The drift notice rides INSIDE the injected context, not on a bare stdout line:
# only additionalContext reaches the session, and a warning the session cannot
# read is the silent failure this script's #491 lesson is about.
[ -n "$drift" ] && ctx="${drift}"$'\n\n'"${ctx}"
jq -n --arg c "$ctx" \
  '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$c}}'
