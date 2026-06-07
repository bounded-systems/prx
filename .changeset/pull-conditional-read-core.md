---
"@bounded-systems/prx": patch
---

feat(sync): pull-leg conditional-read core — ETag parser + per-issue ETag store (GH-296)

The reconcile pull leg (GH→bd) re-reads every pinned GitHub issue every tick and
is not `--limit`-gated — the sync API hog. This lands the pure, isolated core for
GitHub conditional requests, ahead of wiring it into the adapter:

- `sync/conditional-read.ts` — `parseConditionalRead` classifies a `gh api … -i`
  result as not-modified / modified / error. It keys on the HTTP status line, not
  the exit code, because `gh api` exits non-zero on BOTH a `304 Not Modified` and
  a real error (404/410/5xx); a 304 must never be mistaken for a failure, nor a
  failure for "unchanged".
- `sync/pull-etag-store.ts` — per-(repo,domain) persisted `If-None-Match` cache
  (etag + last derived state) under `~/.local/state/prx/sync/<key>/pull-etags.json`,
  loaded once into memory and flushed in a single write per tick.

A `304` is free against the GitHub rate limit and GitHub is authoritative on
changed-vs-unchanged, so reusing cached state on a 304 is provably correct. No
behavior change yet — nothing calls these until the adapter wiring (prx-lzw step b2).
