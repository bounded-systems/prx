/**
 * Door-grant ISSUER (prx-8uf2) — the minting half of the signed-grant gate.
 *
 * keeperd's TCP gate (`src/keeperd/grant-gate.ts`) VERIFIES a presented grant.
 * This module MINTS one: it signs a guest-room `SignedGrant` with a prx
 * keymaker/provenance per-actor key (the decided issuer model — reuse the
 * per-actor ed25519 identities, no new key system) and publishes the matching
 * `IssuerKeys` the door is configured with. Same master ⇒ a grant minted here
 * verifies against the issuer key emitted here, closing the loop end-to-end.
 *
 * Scope: this is the ISSUER + its published key — usable + testable in-process
 * today. The live DISTRIBUTION path (a concierge handing grants to clients +
 * refresh-before-TTL) stays deployment-coupled (prx-9s14); it consumes this
 * minting core rather than replacing it.
 */
import { sign as cryptoSign } from "node:crypto";

import { getEnv } from "@bounded-systems/env";
import {
  signGrant,
  tcp,
  unix,
  type DoorGrant,
  type GrantBinding,
  type IssuerKeys,
  type SignedGrant,
} from "@bounded-systems/guest-room";

import { actorSigningIdentity, deriveActorKeypair } from "../provenance/actor-identity.ts";
import { resolveProvenanceMaster } from "../provenance/config.ts";

/**
 * The actor whose per-actor key signs door grants — the "door authority". A
 * dedicated identity (not a worker actor) so the authority to GRANT door access
 * is separable from the authority to do work. The keymaker derives its key like
 * any other actor; the door is configured with its published public half.
 */
export const DEFAULT_GRANT_ISSUER_ACTOR = "door-authority";

/** A resolved issuer: its published key id + PEM, plus the private signer. */
export interface GrantIssuer {
  /** The issuer key id (`binding.keyId`); the verifier selects the key by this. */
  readonly kid: string;
  /** The published verification key (SPKI PEM) — what the door is configured with. */
  readonly publicKeyPem: string;
  /** Sign the grant's canonical bytes → base64 ed25519 signature. */
  readonly sign: (data: string) => string;
}

/**
 * Resolve the door-authority's signing identity from the provenance master
 * (zero-config dev seed when no master is configured, so mint↔verify is
 * deterministic in dev + tests). The private key never leaves this process.
 */
export function resolveGrantIssuer(
  actor: string = DEFAULT_GRANT_ISSUER_ACTOR,
  env: (key: string) => string | undefined = getEnv,
): GrantIssuer {
  const kp = deriveActorKeypair(resolveProvenanceMaster(env), actorSigningIdentity(actor));
  const publicKeyPem = kp.publicKey.export({ type: "spki", format: "pem" }).toString();
  return {
    kid: kp.keyid,
    publicKeyPem,
    sign: (data) => cryptoSign(null, Buffer.from(data, "utf8"), kp.privateKey).toString("base64"),
  };
}

/**
 * The published `IssuerKeys` set for a door authority — what a door is given
 * (e.g. `KEEPERD_ISSUER_KEYS`) so it can verify grants this issuer mints. A
 * single key today; the set shape supports rotation (publish-new / retire-old).
 */
export function issuerKeys(
  actor: string = DEFAULT_GRANT_ISSUER_ACTOR,
  env: (key: string) => string | undefined = getEnv,
): IssuerKeys {
  const { kid, publicKeyPem } = resolveGrantIssuer(actor, env);
  return { keys: [{ kid, publicKeyPem }] };
}

export interface MintGrantInput {
  /** The door this grant authorizes (e.g. `keeper`) — bound into the signature. */
  readonly door: string;
  /** The room id permitted to present this grant (audience binding). */
  readonly audience: string;
  /** Grant lifetime in seconds — keep SHORT (per-lease, mirroring token TTLs). */
  readonly ttlSeconds: number;
  /** Single-use freshness token (caller-supplied; deterministic in tests). */
  readonly nonce: string;
  /** Now, epoch ms (injected so `exp` is deterministic + testable). */
  readonly now: number;
  /** Issuer actor (defaults to the door authority). */
  readonly actor?: string;
  /**
   * Opaque macaroon-shaped restrictions the serving door enforces (e.g.
   * `repos=owner/repo`, `perms=contents:read`) — see guest-room's
   * `checkCaveats`. Omitted ⇒ an unattenuated grant (the door's full
   * authority). Signed into the grant like every other authority-bearing
   * field, so a caveat can't be stripped in transit.
   */
  readonly caveats?: readonly string[];
}

/**
 * Mint a per-lease {@link SignedGrant} for `door`, signed by the door
 * authority. The signed authority-bearing fields are the door `name`, the guest
 * reference, and the binding (audience / exp / nonce / keyId) — see guest-room's
 * `grantSigningBytes`. `host`/`guest` are descriptive transports; the gate keys
 * authorization off `name` + the binding, so they need only be self-consistent.
 */
export function mintDoorGrant(
  input: MintGrantInput,
  env: (key: string) => string | undefined = getEnv,
): SignedGrant {
  const issuer = resolveGrantIssuer(input.actor ?? DEFAULT_GRANT_ISSUER_ACTOR, env);
  const grant: DoorGrant = {
    name: input.door,
    host: unix(`/run/prx/doors/${input.door}d.sock`),
    guest: tcp("127.0.0.1", 0),
    env: `${input.door.toUpperCase()}_SOCK`,
    grants: `lease via the ${input.door} door`,
    use: `present this grant to the ${input.door} door`,
    ...(input.caveats && input.caveats.length > 0 ? { caveats: [...input.caveats] } : {}),
  };
  const binding: GrantBinding = {
    audience: input.audience,
    exp: input.now + input.ttlSeconds * 1000,
    nonce: input.nonce,
    keyId: issuer.kid,
  };
  return signGrant(grant, binding, issuer.sign);
}
