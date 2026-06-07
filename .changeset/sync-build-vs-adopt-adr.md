---
"@bounded-systems/prx": patch
---

Add the sync-agent build-vs-adopt decision (docs/spikes/prx-3eu): keep dolt as the data-sync framework (already adopted; the daemon's push durability leverages it), keep the bd↔GitHub reconcile bespoke (it's a cross-system transform, not replica sync), and do not adopt a generic sync/CRDT framework. The sync agent is an orchestrator over dolt + the existing reconciler.
