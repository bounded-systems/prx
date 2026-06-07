---
---

internal: migrate `prx skills` off the cli.ts monolith to a spec-driven
VerbSpec (`pr-state/skills-verb.ts`), continuing the catalog/read slice after
`graph`/`actors`/`model`. A pure read over the cli-format leaf — behavior and
output are unchanged; it now also projects to the MCP/OpenAPI surfaces. No
package change.
