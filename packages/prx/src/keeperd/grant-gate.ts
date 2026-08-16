/**
 * keeperd's TCP grant gate (prx-8uf2) — a thin binding of the shared door gate
 * (`src/door/grant-gate.ts`) to the `keeper` door + its env vars.
 *
 * keeperd holds the git push credential. On UNIX the kernel-authenticated peer
 * is the authority (held-ref); on a TCP edge a caller must present a signed
 * grant minted for the `keeper` door (see the shared module for the mechanism,
 * and `src/door/grant-issuer.ts` for minting). The gate lives at the DOOR, as a
 * guest-room `RequestAuthorizer` over the request envelope's `grant`.
 */
import type { RequestAuthorizer } from "@bounded-systems/guest-room/protocol";

import {
  buildDoorAuthorizer,
  resolveDoorGrantGate,
  type DoorGrantGate,
  type ResolveGateDeps,
} from "../door/grant-gate.ts";

export { ed25519VerifyWith } from "../door/grant-gate.ts";

/** The door name keeperd serves — a grant minted for any other door is refused. */
export const KEEPER_DOOR = "keeper";

/** Env: the audience (room id) this keeper accepts grants for. */
export const KEEPER_GRANT_AUDIENCE_ENV = "KEEPERD_GRANT_AUDIENCE";
/** Env: the issuer's published key set — inline JSON, or `@<path>` to a JSON file. */
export const KEEPER_ISSUER_KEYS_ENV = "KEEPERD_ISSUER_KEYS";

/** The resolved gate keeperd enforces on its TCP edge. */
export type KeeperGrantGate = DoorGrantGate;

/**
 * Build the `RequestAuthorizer` for keeperd's TCP edge — a grant minted for the
 * `keeper` door, audience-bound, unexpired, signed by a known issuer key. A unix
 * caller never reaches this (kernel-authenticated).
 */
export function buildKeeperAuthorizer(
  gate: KeeperGrantGate,
  now?: () => number,
): RequestAuthorizer {
  return buildDoorAuthorizer(KEEPER_DOOR, gate, now);
}

/**
 * Resolve keeperd's gate from the environment, or `null` when unconfigured (no
 * TCP enforcement — kept loopback-bound by the publish-side safety fix).
 */
export function resolveKeeperGrantGate(deps: ResolveGateDeps = {}): KeeperGrantGate | null {
  return resolveDoorGrantGate(KEEPER_GRANT_AUDIENCE_ENV, KEEPER_ISSUER_KEYS_ENV, deps);
}
