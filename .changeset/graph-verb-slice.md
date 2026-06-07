---
---

internal: migrate `prx graph` (and the `model graph` alias) off the cli.ts
monolith to a spec-driven VerbSpec (`pr-state/graph-verb.ts`). The command's
behavior, formats, `--validate`/`--output`/`--open`, and human output are
unchanged; it now also projects to the MCP/OpenAPI surfaces. No package change.
