---
"@bounded-systems/prx": patch
---

beadsd writes are now durable (GH-296, sync-agent epic): the daemon's periodic refresh upgrades from a pull-only freshness step to a **full dolt reconcile** (commit local writes → pull → push). Daemon writes (create/update/close/reopen land in the served clone) are now committed and pushed to the canonical remote on the interval, instead of sitting local until the next re-provision. Reuses the `dolt-reconcile` pipeline; quiet and non-throwing — if the push step has no remote creds it's swallowed, and commit+pull still run (writes stay local, never lost). Leverages dolt's native sync (the data-sync framework) rather than a bespoke pusher.
