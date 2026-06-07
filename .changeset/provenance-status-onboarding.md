---
"@bounded-systems/prx": patch
---

`prx provenance status` (GH-352): reports the signing posture — production / bootstrap / drifted / unconfigured — from the master source, per-actor mode, trust-map actor count + drift, and enforcement, and when it's not the production configuration bubbles up the exact onboarding next-steps. So a missing or stale signing setup is discoverable from inside prx, not just the docs. The `prx ci` fail-closed message now points at it.
