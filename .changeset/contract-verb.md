---
---

internal: migrate `prx contract` (a.k.a. `contract show`) off the cli.ts monolith
to a spec-driven VerbSpec (`pr-state/contract-verb.ts`), retiring the last legacy
contract dispatch branch. One verb covers the GH-1821 contract-trinity read
(`--list` / `--kind` over the agent/artifact/transition registries, single-entry
by id, with the `FAIL:` errors) and the bare pr.json skill-event apply (shared
`applySkillEvent`). `contract init` and the migrated `contract <sub>` aliases
route away before it. Behavior and output unchanged; the command now also
projects to the MCP/OpenAPI surfaces. No package change.
