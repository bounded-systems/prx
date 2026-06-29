/**
 * forge-d's TCP grant gate (prx-8uf2) — a thin binding of the shared door gate
 * (`src/door/grant-gate.ts`) to the `forge` door + its env vars.
 *
 * forge-d holds the GitHub App private key and leases short-lived installation
 * tokens. On UNIX the kernel-authenticated peer is the authority (held-ref); on
 * a TCP edge a caller must present a signed grant minted for the `forge` door,
 * else anyone who can dial the port could lease a token. Mirrors keeperd —
 * the mechanism lives in the shared module.
 */
import type { RequestAuthorizer } from "@bounded-systems/guest-room/protocol";

import {
  buildDoorAuthorizer,
  resolveDoorGrantGate,
  type DoorGrantGate,
  type ResolveGateDeps,
} from "../door/grant-gate.ts";

/** The door name forge-d serves — a grant minted for any other door is refused. */
export const FORGE_DOOR = "forge";

/** Env: the audience (room id) this forge-d accepts grants for. */
export const FORGE_GRANT_AUDIENCE_ENV = "FORGE_D_GRANT_AUDIENCE";
/** Env: the issuer's published key set — inline JSON, or `@<path>` to a JSON file. */
export const FORGE_ISSUER_KEYS_ENV = "FORGE_D_ISSUER_KEYS";

/** The resolved gate forge-d enforces on its TCP edge. */
export type ForgeGrantGate = DoorGrantGate;

/**
 * Build the `RequestAuthorizer` for forge-d's TCP edge — a grant minted for the
 * `forge` door, audience-bound, unexpired, signed by a known issuer key. A unix
 * caller never reaches this (kernel-authenticated).
 */
export function buildForgeAuthorizer(gate: ForgeGrantGate, now?: () => number): RequestAuthorizer {
  return buildDoorAuthorizer(FORGE_DOOR, gate, now);
}

/**
 * Resolve forge-d's gate from the environment, or `null` when unconfigured (no
 * TCP enforcement — kept loopback-bound by the publish-side safety fix).
 */
export function resolveForgeGrantGate(deps: ResolveGateDeps = {}): ForgeGrantGate | null {
  return resolveDoorGrantGate(FORGE_GRANT_AUDIENCE_ENV, FORGE_ISSUER_KEYS_ENV, deps);
}
