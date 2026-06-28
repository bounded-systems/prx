---
"@bounded-systems/prx": minor
---

Add the ghappd door core (prx-cdln Phase 1, spec claude-box/GHAPPD.md): the GitHub App credential-broker door holds the App private key and serves a `lease` op returning a short-lived installation token — callers never hold the PEM.

- **src/ghappd/contract.ts** — Zod wire contract (`lease` request with optional `repositories`/`permissions` attenuation; `ok`/`error` response).
- **src/ghappd/daemon.ts** — `handleGhappdRequest` (pure over deps: held App config + injected mint; never throws to the socket; PEM never in a reply) + `serveGhappdConnection`/`runGhappdServe` over the shared `door/framing`, mirroring beadsd.
- **src/ghappd/client.ts** — `IsolatedGhappdClient.lease` over an injected transport, validating both directions (`GhappdProtocolError` on contract violation), mirroring `IsolatedBeadsClient`.

Reuses `mintInstallationToken` server-side. Pure-over-deps, fully offline-tested
(handler logic, framed serve round-trip via a mock socket, client validation).
Remaining Phase 1 wiring — the `ghapp serve` CLI verb, the `prxDoorCatalog`
entry, and the Lima lifecycle — is a focused follow-up; the agent-side broker's
`door` backend (lease instead of local mint) is Phase 2.
