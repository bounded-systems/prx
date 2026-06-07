---
---

internal: migrate `prx actors` and `prx model` (and the `model actors` /
`model show` aliases) off the cli.ts monolith to spec-driven VerbSpecs
(`pr-state/model-verb.ts`), the catalog/read slice of the decomposition. Pure
reads over the cli-format leaf — behavior and output are unchanged; they now
also project to the MCP/OpenAPI surfaces. `model stately` stays on the legacy
handler. No package change.
