---
"@bounded-systems/prx": minor
---

Client-side grant provider (prx-8uf2) — the present-and-refresh half of grant acquisition. `cachingGrantProvider` (`src/door/grant-provider.ts`) holds a signed grant and re-acquires it before TTL (cache + expiry-aware refresh + concurrency dedupe, mirroring the token broker), so a burst of door calls never presents a stale grant. The `acquire` source is injected — a concierge call in production (deployment-coupled, prx-9s14), `mintDoorGrant` in dev/tests — so the cache/refresh/present logic is pure and verifiable independent of where grants come from. Wired into the ghappd client: `createDoorBroker({ grantProvider })` presents a live grant on each lease via guest-room `call(..., { grant })` over a TCP/gated ghappd; omitted ⇒ no grant (a unix door, held-ref). Proven e2e: a provided grant passes the real ghappd gate and leases; without one the gated door rejects (fail-closed). The keeper client can adopt the same door-agnostic provider.
