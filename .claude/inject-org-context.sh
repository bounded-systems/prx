#!/usr/bin/env bash
# SessionStart hook — inject the bounded-systems canonical Claude context.
# Canonical source since .github#175: bounded-systems/.github -> claude/context.md
# (PUBLIC — the #491 audit found nothing private; the .github-private copy stays
# byte-identical until #494 retires it and remains the fallback below).
# Fail OPEN but never SILENT: anything that goes wrong yields no context and one
# status line saying so — a degraded session must be able to tell (#491).
set -uo pipefail
command -v jq >/dev/null 2>&1 || exit 0

path='repos/bounded-systems/.github-private/contents/claude/context.md'
ctx=""

# 0) The public canonical copy — anonymous raw fetch, no token, no clone. This
#    is the source that works in a cloud session with NOTHING attached; every
#    fallback below was measured failing there on 2026-07-31, when the file
#    lived only in the private repo.
if command -v curl >/dev/null 2>&1; then
  ctx="$(curl -fsSL --connect-timeout 5 --max-time 15 \
    https://raw.githubusercontent.com/bounded-systems/.github/main/claude/context.md \
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
  echo "org context NOT loaded — all sources failed (public raw, gh api, git clone, curl+token). Degraded mode: see the org stanza in CLAUDE.md."
  exit 0
fi
jq -n --arg c "$ctx" \
  '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$c}}'