---
"@bounded-systems/prx": minor
---

Door-grant issuer (prx-8uf2) — the minting half of the signed-grant gate. keeperd's TCP gate (#833) verifies a presented grant; this adds the issuer that mints one. `prx door grant --door keeper --audience <room> --ttl 60` mints a short-lived, audience-bound `SignedGrant`, signed by a prx keymaker/provenance per-actor key (the decided issuer model — reuse the per-actor ed25519 identities, no new key system). `prx door issuer-keys` emits the matching published `IssuerKeys` to configure on the door (e.g. `KEEPERD_ISSUER_KEYS`). Same provenance master ⇒ a minted grant verifies against the published issuer key, closing the mint→present→verify loop end-to-end (tested directly against the keeper gate's authorizer). New: `src/door/grant-issuer.ts` + `src/door/grant-verb.ts`. The live distribution path (a concierge handing grants to clients + refresh-before-TTL) stays deployment-coupled (prx-9s14) and consumes this minting core.
