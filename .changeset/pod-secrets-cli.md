---
"@bounded-systems/prx": patch
---

Wire `prx pod secrets` into the CLI dispatch (cli.ts) — the verb was registered (MCP/OpenAPI saw it) but had no `pod secrets` route next to `pod up`, so `prx pod secrets` errored "Unknown subcommand: pod". Follow-up to #806.
