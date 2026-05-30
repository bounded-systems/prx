#!/bin/sh
set -eu

usage() {
  cat <<'EOF'
Usage: git-local-repos [--strict] [--count] [--home <path>]

Lists normalized local Git repository roots.

Options:
  --strict       Scan all paths under home (slower, fewer exclusions).
  --count        Print only the number of discovered repositories.
  --home <path>  Override scan root (defaults to $HOME).
  -h, --help     Show this help.
EOF
}

strict=0
count_only=0
scan_home="${HOME}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --strict)
      strict=1
      ;;
    --count)
      count_only=1
      ;;
    --home)
      shift
      if [ "$#" -eq 0 ]; then
        echo "git-local-repos: missing value for --home" >&2
        exit 2
      fi
      scan_home="$1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "git-local-repos: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

out="$(mktemp -t git-local-repos.XXXXXX)"
trap 'rm -f "$out"' EXIT

if [ "$strict" -eq 1 ]; then
  find "$scan_home" \
    \( -type d -name .git -o -type f -name .git \) -print0 2>/dev/null
else
  find "$scan_home" \
    \( \
      -path "$scan_home/Library" -o \
      -path "$scan_home/.cache" -o \
      -path "$scan_home/.Trash" -o \
      -path "$scan_home/.local/share/Trash" -o \
      -path "$scan_home/.npm" -o \
      -path "$scan_home/.pnpm-store" -o \
      -path "$scan_home/.cargo/registry" -o \
      -path "$scan_home/.cargo/git" \
    \) -prune -o \
    \( -type d -name .git -o -type f -name .git \) -print0 2>/dev/null
fi | while IFS= read -r -d '' gitpath; do
  candidate="$(dirname "$gitpath")"
  repo=""

  if git --no-pager -C "$candidate" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    repo="$(git --no-pager -C "$candidate" rev-parse --show-toplevel 2>/dev/null || true)"
  elif [ "$(git --no-pager -C "$candidate" rev-parse --is-bare-repository 2>/dev/null || echo false)" = "true" ]; then
    repo="$(git --no-pager -C "$candidate" rev-parse --absolute-git-dir 2>/dev/null || true)"
  fi

  [ -n "$repo" ] || continue

  case "$repo" in
    */.git/*)
      continue
      ;;
  esac

  printf '%s\n' "$repo"
done | awk '!seen[$0]++' | sort > "$out"

if [ "$count_only" -eq 1 ]; then
  wc -l < "$out"
else
  cat "$out"
fi
