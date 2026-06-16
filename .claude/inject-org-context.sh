#!/usr/bin/env bash
# SessionStart hook — inject the bounded-systems canonical Claude context.
# Canonical source: bounded-systems/.github-private -> claude/context.md
# Fail OPEN: anything that goes wrong yields no context, never a blocked session.
set -uo pipefail
command -v jq >/dev/null 2>&1 || exit 0

path='repos/bounded-systems/.github-private/contents/claude/context.md'
ctx=""

# 1) gh API — local dev, or cloud only if gh is installed AND a token is present.
if command -v gh >/dev/null 2>&1; then
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

[ -z "$ctx" ] && exit 0   # fail open
jq -n --arg c "$ctx" \
  '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$c}}'