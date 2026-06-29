/**
 * keeperd's TCP grant gate (prx-8uf2, the door-side half of the door-bridge).
 *
 * keeperd is a CREDENTIAL door — it holds the git push credential. On a UNIX
 * socket the kernel authenticates the peer, so the held reference IS the
 * authority (no grant needed; in-pod siblings reach it over the door fabric).
 * But on a TCP edge (the macOS/virtiofs workaround, or any host/cross-host
 * reach) a reachable socket is NOT authority: anyone who can dial the port could
 * push. So a TCP caller must present a SIGNED GRANT — audience/exp/door-bound,
 * signed by a published issuer key — and keeperd verifies it BEFORE dispatch.
 *
 * This is the capability-transport model exactly ("held-ref local, signed grant
 * in transit"): the gate lives at the DOOR, as a guest-room `RequestAuthorizer`
 * over the request envelope's `grant` — NOT in a forwarding bridge (the bridge
 * stays frame-transparent; see `docs/prx/door-bridge.md` + `src/door/bridge.ts`).
 * We reuse guest-room's `signedGrantAuthorizer` / `verifyGrantWithKeys`; the only
 * prx-side pieces are the ed25519 crypto and the host-side config seam.
 *
 * The PRODUCTION source of the issuer keys + audience (concierge / keymaker
 * publication, grant acquisition) is the live-deployment concern tracked by
 * prx-9s14; this module is the enforcement seam, mirroring how ghappd resolves
 * its App key host-side via `resolveBrokerConfig`.
 */
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { readFileSync } from "node:fs";

import { getEnv } from "@bounded-systems/env";
import { type IssuerKeys } from "@bounded-systems/guest-room";
import { signedGrantAuthorizer, type RequestAuthorizer } from "@bounded-systems/guest-room/protocol";

/** The door name keeperd serves — a grant minted for any other door is refused. */
export const KEEPER_DOOR = "keeper";

/** Env: the audience (room id) this keeper accepts grants for. */
export const KEEPER_GRANT_AUDIENCE_ENV = "KEEPERD_GRANT_AUDIENCE";
/** Env: the issuer's published key set — inline JSON, or `@<path>` to a JSON file. */
export const KEEPER_ISSUER_KEYS_ENV = "KEEPERD_ISSUER_KEYS";

/**
 * Verify an ed25519 grant signature (base64) over `data` against a PEM public
 * key. The injected `verifyWith` for guest-room's grant verification. Any
 * malformed key/signature is a verification FAILURE (false), never a throw — a
 * bad grant must deny, not crash the daemon.
 */
export function ed25519VerifyWith(data: string, signatureB64: string, publicKeyPem: string): boolean {
  try {
    return cryptoVerify(
      null,
      Buffer.from(data, "utf8"),
      createPublicKey(publicKeyPem),
      Buffer.from(signatureB64, "base64"),
    );
  } catch {
    return false;
  }
}

/** The resolved gate keeperd enforces on its TCP edge. */
export interface KeeperGrantGate {
  /** The issuer's published verification keys (selected per grant by `kid`). */
  readonly keys: IssuerKeys;
  /** The room id permitted to present grants to THIS keeper (audience binding). */
  readonly audience: string;
}

/**
 * Build the `RequestAuthorizer` for keeperd's TCP edge: a request is served iff
 * it carries a `grant` that is (a) minted for the `keeper` door, (b) audience-
 * bound to us, (c) unexpired, and (d) signed by a known published issuer key.
 * A unix caller never reaches this — the kernel already authenticated it.
 */
export function buildKeeperAuthorizer(gate: KeeperGrantGate, now?: () => number): RequestAuthorizer {
  return signedGrantAuthorizer({
    keys: gate.keys,
    audience: gate.audience,
    door: KEEPER_DOOR,
    verifyWith: ed25519VerifyWith,
    ...(now ? { now } : {}),
  });
}

/** Injectable seams for {@link resolveKeeperGrantGate} (tests pass fakes). */
export interface ResolveGateDeps {
  env?: (key: string) => string | undefined;
  readFile?: (path: string) => string;
}

/**
 * Resolve the gate from the ambient environment, or `null` when unconfigured
 * (⇒ keeperd does NOT enforce grants on TCP — today's behavior, kept loopback-
 * bound by the publish-side safety fix). Both the audience and the issuer keys
 * must be present to form a gate; one without the other is a misconfiguration
 * that resolves to `null` (the caller WARNs). The keys value is inline JSON, or
 * `@<path>` to a JSON file holding an `IssuerKeys` object.
 */
export function resolveKeeperGrantGate(deps: ResolveGateDeps = {}): KeeperGrantGate | null {
  const env = deps.env ?? getEnv;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));

  const audience = env(KEEPER_GRANT_AUDIENCE_ENV);
  const keysRaw = env(KEEPER_ISSUER_KEYS_ENV);
  if (!audience || !keysRaw) return null;

  const json = keysRaw.startsWith("@") ? readFile(keysRaw.slice(1)) : keysRaw;
  let keys: IssuerKeys;
  try {
    keys = JSON.parse(json) as IssuerKeys;
  } catch {
    throw new Error(`${KEEPER_ISSUER_KEYS_ENV}: not valid JSON IssuerKeys`);
  }
  if (!Array.isArray(keys.keys) || keys.keys.length === 0) {
    throw new Error(`${KEEPER_ISSUER_KEYS_ENV}: expected { keys: [{ kid, publicKeyPem }, ...] }`);
  }
  return { keys, audience };
}
