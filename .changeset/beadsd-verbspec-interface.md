---
"@bounded-systems/prx": minor
---

beadsd: publish its method surface as a verbspec interface (IDL). A new `beadsd/verbs.ts` projects the existing `BeadsRequestSchema` wire contract into a verbspec `Registry` (one verb per request `kind`, input derived from the union member, output the shared response schema) and emits a committed OpenRPC document (`beadsd.openrpc.json`) as beadsd's published interface. Projection-only in this slice — beadsd still serves over its existing `{kind}` envelope; wiring `dispatchNdjson` as the transport is a follow-up. Drift-guarded so the interface can't diverge from the wire contract or the committed artifact.
