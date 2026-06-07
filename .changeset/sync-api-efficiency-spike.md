---
"@bounded-systems/prx": patch
---

Add the sync API-efficiency design (docs/spikes/prx-ebo): grounds the "sync ate more API requests than necessary" concern — the reconcile's pull leg re-reads every pinned GitHub issue every tick (not --limit-gated) — and sequences the two fixes: pull-leg conditional reads (GitHub ETags / GraphQL batching, the hog) and a push-leg bead-etag short-circuit with retry-safety (the cheap, safe win).
