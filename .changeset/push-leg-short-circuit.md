---
"@bounded-systems/prx": patch
---

perf(sync): short-circuit the bd→GH push leg when the bead store hasn't moved

runBeadsSync now reads the dolt clone's `hashof('HEAD')` and compares it against a
per-(repo,domain) "last successfully pushed HEAD" watermark. When the bead store is
unchanged since the last fully-successful push, the push leg is skipped entirely —
no per-bead GitHub mirror writes. The watermark only advances on a clean push
(no deferrals, no errors), so a partial failure safely retries next tick. `--dry-run`
never skips. (GH-296 / prx-lzw step a)
