---
"@bounded-systems/prx": patch
---

`scout read` signing is now fail-closed in a signing context (GH-352), mirroring `prx ci`: when a read is in scope of a provenance ledger (a reserved work-unit / pipeline) but no signer is configured, the read is refused with a clear message (`prx provenance setup` / `prx provenance status`) — an unsigned in-pipeline read is not trusted. A bare read outside a work-unit (no canonical ledger) is unaffected, and a transient signing-execution error when a signer IS configured stays best-effort (never drops the read).
