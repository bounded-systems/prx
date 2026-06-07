---
"@bounded-systems/prx": patch
---

beadsd now surfaces a **dataset etag** on every `ok` reply (GH-296, prx-ebk): the served clone's dolt HEAD hash — one cheap content-addressed generation token for the whole bead store. The daemon caches it (read on start + after each reconcile via `prx beads serve`'s `readHead`), so reads don't spawn dolt per request. Unchanged HEAD ⇒ nothing moved, so callers can validate caches and sync can short-circuit (skip redundant GitHub API calls) when the bead DB hasn't advanced. The field is optional; the daemon omits it when no HEAD source is wired.
