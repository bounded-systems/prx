---
"@bounded-systems/prx": patch
---

Adds the local CI provenance projection (GH-352): a `ci` field on `DomainStateV1` (verdict + freshness), the `resolveCiProvenanceState` reader (merge-guard verdict for HEAD plus an `isStale` freshness check — does the recorded green still cover the current tree?), and a uniform `isStale` check in the merge-guard (`projectProvenanceAxis`) so a verified-but-stale derivation fails closed. `buildDomainState`/`prx snapshot` stay synchronous and ledger-free; the `ci` field defaults there pending an async-snapshot follow-up.
