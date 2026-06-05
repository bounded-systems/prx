---
"@bounded-systems/prx": minor
---

**Experimental: pilot/fleet pipeline orchestrator + spec-driven CLI surface.** A
preview subsystem (tested; not yet wired as `prx` commands — the real run is
behind `PRX_PILOT_REAL` and gated on the dolt actor). Ships as a tested
subsystem behind the existing surfaces.

- **feat(orchestrator):** `pilot` (Layer 1) drives one work unit — each role leg
  invokes a headless Claude subagent (no tmux, "claude over ssh") and signs an
  in-toto step link. The tail `awaiting_ci → ready_to_merge → sealing → merged`
  makes "CI is a HARD BLOCK" *structural* — the only edge to merge runs through
  a settled-green gate. Termination is proven via a well-founded measure
  `[retreatBudget, distanceToMerged] ∈ ℕ²`. `fleet` (Layer 2) supervises many
  pilots, WIP-bounded, projecting a live board (the agents view) + a signed
  batch attestation.
- **feat(provenance):** a signed in-toto tree — leg step → pilot summary
  (`prx.pilot/v1`) → fleet batch (`prx.fleet/v1`), real ed25519/DSSE via
  `resolveProvenanceSigner`; verifiable, tamper / wrong-key rejected.
- **feat(cli-spec):** author a verb once as a Zod `VerbSpec`; project it to CLI
  / MCP / OpenAPI / Anthropic tools / a Claude Code plugin / `prx mcp serve`,
  with a namespaced router and an actor→tool permission projection — the basis
  for collapsing `cli.ts` to a thin router + pretty-printer.
- **feat(invariant):** no prx agent launches without a signing key
  (`requireSigner`); the CLI is modeled as an actor that inherits identity from
  the controlling tty (`cliActor` → `human` / `noninteractive`,
  `requireCliSigner`).
- **feat(real):** the `prx pilot` real path (`PRX_PILOT_REAL`) wires legs to
  `openSession` + a headless role agent + the Signer, and the tail to the real
  `prx scout ci` / `prx publisher merge` actors.

Design: `docs/prx/pipeline-orchestrator.md`, `docs/prx/cli-from-spec.md`.
