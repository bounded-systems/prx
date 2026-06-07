---
---

internal: migrate `prx open-mode` off the cli.ts monolith to a spec-driven
VerbSpec (`pr-state/open-mode-verb.ts`), continuing the contract-read slice
after graph/actors/model/skills. A pure read over the contract + cli-format
leaves — behavior, formats (mode/json/gh-create/gh-ready), and the
`--pr`-required error are unchanged; it now also projects to the MCP/OpenAPI
surfaces. No package change.
