---
"@bounded-systems/prx": patch
---

`BeadsResolver` (the canonical=bd hydrate path) now reads through beadsd (GH-296): the `BD-<8hex>` + external-ref snapshot scans use `loadAllBeadsViaDaemon` and the record fetch uses `showBeadViaDaemon`, instead of local `runBdShow`/`loadAllBeads`. Per the per-repo/single-workspace decision (one daemon = one repo; multi-tenant rejected), the resolver's `cwd` is vestigial — it routes to the single per-repo daemon. `toBdLongId` (used by `primePlanSession`'s canonical=bd fork) is now async.
