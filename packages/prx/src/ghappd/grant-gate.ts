/**
 * ghappd's TCP grant gate (prx-8uf2) — a thin binding of the shared door gate
 * (`src/door/grant-gate.ts`) to the `ghapp` door + its env vars.
 *
 * ghappd holds the GitHub App private key and leases short-lived installation
 * tokens. On UNIX the kernel-authenticated peer is the authority (held-ref); on
 * a TCP edge a caller must present a signed grant minted for the `ghapp` door,
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

/** The door name ghappd serves — a grant minted for any other door is refused. */
export const GHAPP_DOOR = "ghapp";

/** Env: the audience (room id) this ghappd accepts grants for. */
export const GHAPP_GRANT_AUDIENCE_ENV = "GHAPPD_GRANT_AUDIENCE";
/** Env: the issuer's published key set — inline JSON, or `@<path>` to a JSON file. */
export const GHAPP_ISSUER_KEYS_ENV = "GHAPPD_ISSUER_KEYS";

/** The resolved gate ghappd enforces on its TCP edge. */
export type GhappGrantGate = DoorGrantGate;

/**
 * Build the `RequestAuthorizer` for ghappd's TCP edge — a grant minted for the
 * `ghapp` door, audience-bound, unexpired, signed by a known issuer key. A unix
 * caller never reaches this (kernel-authenticated).
 */
export function buildGhappAuthorizer(gate: GhappGrantGate, now?: () => number): RequestAuthorizer {
  return buildDoorAuthorizer(GHAPP_DOOR, gate, now);
}

/**
 * Resolve ghappd's gate from the environment, or `null` when unconfigured (no
 * TCP enforcement — kept loopback-bound by the publish-side safety fix).
 */
export function resolveGhappGrantGate(deps: ResolveGateDeps = {}): GhappGrantGate | null {
  return resolveDoorGrantGate(GHAPP_GRANT_AUDIENCE_ENV, GHAPP_ISSUER_KEYS_ENV, deps);
}
