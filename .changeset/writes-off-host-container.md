---
"@bounded-systems/prx": patch
---

Move the cold `schema_repair` bd op off host bd (prx-82b Slice 2e.2a): the
bootstrap schema-repair op now defaults to an ephemeral beadsd-box container
(`containerBdSchemaRunner`) instead of host bd. The host primitive
(`defaultBdRunner`) stays as the injectable test seam. (The watermark `bd config
get/set` is on the hot, runtime-free freshness path — `work --check` →
freshness-gate → getWatermark — so it can't spawn a container; it needs a beadsd
door config-verb instead, deferred to 2e.2b.)
