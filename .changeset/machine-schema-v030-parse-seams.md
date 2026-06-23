---
---

Migrate to `@bounded-systems/machine-schema` v0.3.0 parse-seam API: replace
direct zod schema access with `parseRawStateV1`, `parseHandoffEnvelope`,
`safeParseHandoffTargetActor`, and `HANDOFF_TARGET_ACTOR_VALUES`. Updates
`anchored-chain-bridge` to use a typed `z.looseObject` input shape so the
drift-pin test can introspect required fields through `ZodPipe`. No release.
