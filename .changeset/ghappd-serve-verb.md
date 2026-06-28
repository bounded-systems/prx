---
"@bounded-systems/prx": minor
---

Add `prx ghapp serve` — run the ghappd GitHub App credential-broker door — as a spec-driven VerbSpec (prx-cdln Phase 1 wiring).

Authoring the verb once with `defineVerb` projects it to the CLI, MCP, and
OpenAPI surfaces (and the help/registry projections regenerate), so it needs no
hand-wired `registry.data.ts` entry or new actor — it registers in
`cli/verb-registry.ts` like the other infra verbs (`pod up`). `run` resolves the
App key host-side via `resolveBrokerConfig` (held in the daemon, never leaving
the door), starts `runGhappdServe`, logs the listen socket, and blocks until the
process is terminated. Unconfigured ⇒ the door still serves but leases reply
error (loud at lease time). Regenerates `openapi.json` + help snapshots.

With this, the door is runnable end-to-end: `prx ghapp serve --socket <path>`,
and agents lease from it via the broker's door backend (`PRX_GH_APP_DOOR`).
