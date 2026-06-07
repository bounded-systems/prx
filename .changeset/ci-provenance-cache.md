---
"@bounded-systems/prx": patch
---

`prx snapshot` now surfaces the CI provenance verdict + freshness in `DomainStateV1.ci` via a cached layer (GH-352): `prx ci` writes the verdict to `.pr/local/ci-provenance.json` while the ledger is open, and `snapshot` reads it synchronously and recomputes freshness against HEAD (`fresh` while the cached commit is still HEAD, `stale` once it moves) — so the read stays synchronous and ledger-free.
