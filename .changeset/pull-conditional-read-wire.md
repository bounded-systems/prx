---
"@bounded-systems/prx": patch
---

feat(sync): wire pull-leg conditional reads into the gh adapter + reconcile (GH-296)

The reconcile pull leg now does GitHub conditional requests, cutting its per-tick
rate-limit spend on unchanged issues (prx-lzw lever 1, building on the core in #504):

- `GhDomainAdapter.pull()` gains an optional `conditionalRead` cache. When wired,
  it issues `gh api repos/{owner}/{repo}/issues/{n} -i -H "If-None-Match: <etag>"`:
  a `304 Not Modified` (free against the rate limit) reuses the cached patch; a
  `2xx` re-parses the fresh REST body and updates the cache; anything else throws.
  The decision is made from the HTTP status line, not the exit code (`gh api`
  exits non-zero on both a 304 and a real error). Absent ⇒ unconditional
  `gh issue view` (unchanged behavior). The REST and `gh issue view` bodies share
  one `parseIssuePatch`.
- `runBeadsSync` constructs a per-(repo,domain) `createPullEtagStore`, wires it into
  the gh adapter, and flushes it once after the pull leg (one file write per tick).

A 304 is free and GitHub is authoritative on changed-vs-unchanged, so reusing
cached state is provably correct (not a client-side heuristic).
