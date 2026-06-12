---
"@bounded-systems/verbspec": minor
"@bounded-systems/prx": patch
---

Extract the spec-driven CLI core into a standalone `@bounded-systems/verbspec` package.

`VerbSpec`, `defineVerb`, `parseArgs`, `dispatch`, and the MCP / OpenAPI / Anthropic / CLI projections move out of `packages/prx/src/cli/verbspec.ts` (now `@bounded-systems/verbspec`, a `zod`-peer-dependency library) so the `@bounded-systems` libraries can author a verb once and share every surface projection. prx's change is internal-only: all verb authoring now imports the new package; no CLI/MCP/OpenAPI behavior changes.
