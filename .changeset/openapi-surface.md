---
"@bounded-systems/prx": patch
---

Emit the OpenAPI projection of the VerbSpec registry to `packages/prx/openapi.json`
— verbspec's fourth surface (CLI / MCP / Anthropic / OpenAPI) made real. The
document is generated from the verbs (`bun run openapi:render`) and drift-gated by
`test/cli/openapi.test.ts`, so it can't fall out of sync with the registry.
