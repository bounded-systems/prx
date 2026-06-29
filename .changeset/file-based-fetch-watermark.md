---
"@bounded-systems/prx": minor
---

Move the gh-issues + slack fetch cursors off host `bd config` to a local-first
file store (prx-82b Slice 2e.2). The watermark is an optimization cursor (the
last mirrored `updatedAt`/`ts`), not data that must travel — the canonical issue
data lives in beads (which travels via dolt). Like git-ai's local tracking (and
the sync agent's `push-watermark`), it now lives host-local under
`~/.local/state/prx/sync/`. A missing cursor is never wrong — it self-heals to a
full re-fetch. This removes the last hot host-`bd config` user: the cursor is on
the sync, no-subprocess `work --check`/freshness path, so it can route through
neither a container (CI hang) nor the beadsd door (subprocess) — a plain local
file is the right home. `WatermarkDeps` swaps its `bd` runner seam for injectable
`readFile`/`writeFile`/`env`.
