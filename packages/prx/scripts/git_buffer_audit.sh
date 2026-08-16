#!/bin/sh
set -eu

usage() {
  cat <<'EOF'
Usage: git-buffer-audit [--strict] [--fix] [--show-issues]

Audits local repositories for local buffer remote correctness.

Defaults:
  - Uses git-local-repos safe scan mode
  - Read-only audit (no changes)

Options:
  --strict       Use strict git-local-repos scan.
  --fix          Run ensure_local_buffer_remote.sh in each non-bare repo before auditing.
  --show-issues  Print all issues (default prints first 40).
  -h, --help     Show this help.
EOF
}

strict=0
fix=0
show_issues=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --strict)
      strict=1
      ;;
    --fix)
      fix=1
      ;;
    --show-issues)
      show_issues=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "git-buffer-audit: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
LOCAL_REPOS_SCRIPT="$SCRIPT_DIR/git_local_repos.sh"
ENSURE_HOOK="$SCRIPT_DIR/ensure_local_buffer_remote.sh"
BUFFER_ROOT="${HOME}/.local/state/git/buffer"

repos_file="$(mktemp -t git-buffer-audit.repos.XXXXXX)"
repo_issues="$(mktemp -t git-buffer-audit.repo-issues.XXXXXX)"
buffer_issues="$(mktemp -t git-buffer-audit.buffer-issues.XXXXXX)"
trap 'rm -f "$repos_file" "$repo_issues" "$buffer_issues"' EXIT

if [ ! -x "$LOCAL_REPOS_SCRIPT" ]; then
  echo "git-buffer-audit: missing helper script: $LOCAL_REPOS_SCRIPT" >&2
  exit 1
fi

if [ "$strict" -eq 1 ]; then
  "$LOCAL_REPOS_SCRIPT" --strict > "$repos_file"
else
  "$LOCAL_REPOS_SCRIPT" > "$repos_file"
fi

: > "$repo_issues"
: > "$buffer_issues"

repo_total=0
repo_bare=0
repo_work=0
fix_ok=0
fix_fail=0
local_ok=0
local_missing=0
local_outside=0
local_path_bad=0
target_missing=0
target_nonbare=0

while IFS= read -r repo; do
  [ -z "$repo" ] && continue
  repo_total=$((repo_total + 1))

  is_bare="$(git --no-pager -C "$repo" rev-parse --is-bare-repository 2>/dev/null || echo true)"
  if [ "$is_bare" = "true" ]; then
    repo_bare=$((repo_bare + 1))
    continue
  fi

  repo_work=$((repo_work + 1))

  if [ "$fix" -eq 1 ]; then
    if (cd "$repo" && "$ENSURE_HOOK") >/dev/null 2>&1; then
      fix_ok=$((fix_ok + 1))
    else
      fix_fail=$((fix_fail + 1))
      printf '%s\tFIX_HOOK_FAILED\n' "$repo" >> "$repo_issues"
      continue
    fi
  fi

  local_url="$(git --no-pager -C "$repo" remote get-url local 2>/dev/null || true)"
  if [ -z "$local_url" ]; then
    local_missing=$((local_missing + 1))
    printf '%s\tLOCAL_REMOTE_MISSING\n' "$repo" >> "$repo_issues"
    continue
  fi

  case "$local_url" in
    file://"$BUFFER_ROOT"/*)
      local_path="${local_url#file://}"
      case "$local_path" in
        *.git) ;;
        *)
          local_path_bad=$((local_path_bad + 1))
          printf '%s\tBUFFER_PATH_SHAPE_BAD\t%s\n' "$repo" "$local_url" >> "$repo_issues"
          ;;
      esac

      if [ ! -d "$local_path" ]; then
        target_missing=$((target_missing + 1))
        printf '%s\tBUFFER_TARGET_MISSING\t%s\n' "$repo" "$local_url" >> "$repo_issues"
        continue
      fi

      target_is_bare="$(git --no-pager -C "$local_path" rev-parse --is-bare-repository 2>/dev/null || echo false)"
      if [ "$target_is_bare" = "true" ]; then
        local_ok=$((local_ok + 1))
      else
        target_nonbare=$((target_nonbare + 1))
        printf '%s\tBUFFER_TARGET_NON_BARE\t%s\n' "$repo" "$local_url" >> "$repo_issues"
      fi
      ;;
    *)
      local_outside=$((local_outside + 1))
      printf '%s\tLOCAL_REMOTE_OUTSIDE_BUFFER\t%s\n' "$repo" "$local_url" >> "$repo_issues"
      ;;
  esac
done < "$repos_file"

buffer_total=0
buffer_bare_ok=0
buffer_nonbare=0

if [ -d "$BUFFER_ROOT" ]; then
  while IFS= read -r buffer_repo; do
    [ -z "$buffer_repo" ] && continue
    buffer_total=$((buffer_total + 1))
    is_bare="$(git --no-pager -C "$buffer_repo" rev-parse --is-bare-repository 2>/dev/null || echo false)"
    if [ "$is_bare" = "true" ]; then
      buffer_bare_ok=$((buffer_bare_ok + 1))
    else
      buffer_nonbare=$((buffer_nonbare + 1))
      printf '%s\tBUFFER_REPO_NON_BARE\n' "$buffer_repo" >> "$buffer_issues"
    fi
  done <<EOF
$(find "$BUFFER_ROOT" -type d -name '*.git' 2>/dev/null | sort)
EOF
fi

printf 'repo_total=%s\n' "$repo_total"
printf 'repo_work=%s\n' "$repo_work"
printf 'repo_bare=%s\n' "$repo_bare"
printf 'fix_ok=%s\n' "$fix_ok"
printf 'fix_fail=%s\n' "$fix_fail"
printf 'local_ok_buffer_bare=%s\n' "$local_ok"
printf 'local_missing=%s\n' "$local_missing"
printf 'local_outside_buffer=%s\n' "$local_outside"
printf 'local_buffer_path_shape_bad=%s\n' "$local_path_bad"
printf 'local_buffer_target_missing=%s\n' "$target_missing"
printf 'local_buffer_target_nonbare=%s\n' "$target_nonbare"
printf 'buffer_repo_total=%s\n' "$buffer_total"
printf 'buffer_repo_bare_ok=%s\n' "$buffer_bare_ok"
printf 'buffer_repo_nonbare=%s\n' "$buffer_nonbare"

if [ -s "$repo_issues" ]; then
  if [ "$show_issues" -eq 1 ]; then
    printf '\nrepo_issues:\n'
    cat "$repo_issues"
  else
    printf '\nrepo_issues (first 40, use --show-issues for all):\n'
    sed -n '1,40p' "$repo_issues"
  fi
fi

if [ -s "$buffer_issues" ]; then
  if [ "$show_issues" -eq 1 ]; then
    printf '\nbuffer_issues:\n'
    cat "$buffer_issues"
  else
    printf '\nbuffer_issues (first 40, use --show-issues for all):\n'
    sed -n '1,40p' "$buffer_issues"
  fi
fi

issue_count=$((fix_fail + local_missing + local_outside + local_path_bad + target_missing + target_nonbare + buffer_nonbare))
if [ "$issue_count" -gt 0 ]; then
  exit 1
fi
