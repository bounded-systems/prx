---
"@bounded-systems/prx": patch
---

deps: migrate to zod 4 (`^4.4.3`). Replaces the Zod-3-only `zod-to-json-schema` with Zod 4's built-in `z.toJSONSchema` behind a shared `toJsonSchemaArtifact` helper (preserving the `{ $ref, definitions }` artifact wrapper), switches `z.record(value)` call sites to the Zod-4 `z.record(key, value)` arity, uses `z.partialRecord` for enum-keyed counters, and updates config-drift issue introspection to Zod 4's `invalid_value`/`values` issue shape. Committed JSON-schema artifacts were regenerated (Zod 4 emits nullable unions as `anyOf` and bounds integers at `MAX_SAFE_INTEGER`); the contract artifacts also pick up roles that had drifted from source. prx-mt9.
