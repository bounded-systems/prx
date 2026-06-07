---
"@bounded-systems/prx": patch
---

feat(beads): route `prx beads publish`'s external-ref write-back through the daemon (GH-296)

`publish`'s link/adopt and create-then-link paths wrote the GH issue URL back to
bd with host `bd update <id> --external-ref <url>` against the per-clone `.beads`.
Both write-backs now run `prx beads update <id> --external-ref <url>` through the
daemon (single writer), using the `update --external-ref` field added in #528. A
sync runner is threaded through `publishOne`/`publishOneInner`/`linkExistingResult`
(injectable for tests); the dedup read stays on the existing loader. Toward
removing host bd (prx-82b).
