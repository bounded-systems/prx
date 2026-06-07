---
"@bounded-systems/prx": patch
---

feat(adapters): route the gh mirror write-back through the daemon (GH-296)

`GhDomainAdapter.push()`'s unlinked-create path wrote the new issue URL back to
bd with host `bd update <id> --external-ref <url>` against the per-clone `.beads`.
That write-back now goes through `updateBeadViaDaemon` (the single writer), using
the `update --external-ref` field added to the daemon contract. `push()` is async,
so it awaits the helper directly; the writer is injectable (`deps.updateBead`) for
tests and defaults to the daemon helper in production. The cache `invalidate()` on
success is unchanged. Another bulk write reconciler off host bd, toward prx-82b.
