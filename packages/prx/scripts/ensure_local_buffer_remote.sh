#!/bin/sh
set -eu

if ! git --no-pager rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  exit 0
fi

if [ "$(git --no-pager rev-parse --is-bare-repository 2>/dev/null || echo false)" = "true" ]; then
  exit 0
fi

origin_url="$(git --no-pager remote get-url origin 2>/dev/null || true)"
owner=""
repo=""
path=""

case "$origin_url" in
  git@github.com:*)
    path="${origin_url#git@github.com:}"
    ;;
  ssh://git@github.com/*)
    path="${origin_url#ssh://git@github.com/}"
    ;;
  https://github.com/*)
    path="${origin_url#https://github.com/}"
    ;;
  http://github.com/*)
    path="${origin_url#http://github.com/}"
    ;;
esac

if [ -n "$path" ]; then
  path="${path%.git}"
  owner="${path%%/*}"
  repo="${path##*/}"
fi

if [ -z "$repo" ]; then
  repo="$(basename "$(git --no-pager rev-parse --show-toplevel)")"
  owner="_local"
fi

buffer_root="$HOME/.local/state/git/buffer"
buffer_dir="$buffer_root/$owner"
buffer_repo="$buffer_dir/$repo.git"

mkdir -p "$buffer_dir"

if [ ! -d "$buffer_repo" ]; then
  git --no-pager init --bare "$buffer_repo" >/dev/null
fi

git --no-pager --git-dir "$buffer_repo" config receive.denyNonFastForwards true
git --no-pager --git-dir "$buffer_repo" config receive.denyDeletes true
git --no-pager --git-dir "$buffer_repo" config transfer.fsckObjects true
git --no-pager --git-dir "$buffer_repo" config receive.fsckObjects true
git --no-pager --git-dir "$buffer_repo" config gc.pruneExpire "24 hours ago"
git --no-pager --git-dir "$buffer_repo" config gc.reflogExpire "24 hours"
git --no-pager --git-dir "$buffer_repo" config gc.reflogExpireUnreachable "1 hour"

remote_url="file://$buffer_repo"
current_url="$(git --no-pager remote get-url local 2>/dev/null || true)"

case "$current_url" in
  "")
    ;;
  file://"$buffer_root"/*)
    ;;
  *)
    exit 0
    ;;
esac

if [ -z "$current_url" ]; then
  git --no-pager remote add local "$remote_url"
elif [ "$current_url" != "$remote_url" ]; then
  git --no-pager remote set-url local "$remote_url"
fi
