---
"@bounded-systems/prx": patch
---

Hoist the OpenAPI projection's per-verb schemas into `components/schemas`: each
operation is now a thin `$ref` to `<VerbToken>Input` / `<VerbToken>Output` rather
than an inlined schema. The result is the conventional, consumer-referenceable
OpenAPI shape and ~57% smaller (37 KB vs 89 KB — it also drops 60 redundant
`$schema` dialect markers). Built by hand so ids and refs stay consistent: Zod's
registry-based dedup emits dangling `$ref`s for the space-namespaced verb ids, and
the verbs' schemas are self-contained today (no shared sub-schemas to dedupe), so
components are 1:1 with operations — the hoist is the structure dedup would use if
shared schemas ever appear.
