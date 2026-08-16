/**
 * Shared door-side signed-grant gate (prx-8uf2) — the enforcement primitive
 * every credential door reuses (keeperd, forge-d, …).
 *
 * A credential door served over UNIX trusts the kernel-authenticated peer (the
 * held reference IS the authority). Served over a TCP/vsock edge, a reachable
 * socket is NOT authority, so a caller must present a SIGNED GRANT — audience /
 * exp / door-bound, signed by a published issuer key — verified BEFORE dispatch.
 * The gate is a guest-room `RequestAuthorizer` over the request envelope's
 * `grant`; we reuse guest-room's `signedGrantAuthorizer` / `verifyGrantWithKeys`,
 * and the only prx-side pieces are the ed25519 crypto and the host-side config
 * seam. Per-door wrappers (`keeperd/grant-gate.ts`, `forge-d/grant-gate.ts`) bind
 * the door name + its env var names; the mechanism lives here once.
 *
 * The PRODUCTION source of the issuer keys + audience (keymaker publication +
 * grant acquisition) is the deployment concern tracked by prx-9s14; minting is
 * `src/door/grant-issuer.ts`. This module is the enforcement seam.
 */
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { readFileSync } from "node:fs";

import { getEnv } from "@bounded-systems/env";
import { type IssuerKeys } from "@bounded-systems/guest-room";
import {
  signedGrantAuthorizer,
  type RequestAuthorizer,
} from "@bounded-systems/guest-room/protocol";

/**
 * Verify an ed25519 grant signature (base64) over `data` against a PEM public
 * key. The injected `verifyWith` for guest-room's grant verification. Any
 * malformed key/signature is a verification FAILURE (false), never a throw — a
 * bad grant must deny, not crash the daemon.
 */
export function ed25519VerifyWith(
  data: string,
  signatureB64: string,
  publicKeyPem: string,
): boolean {
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

/** The resolved gate a door enforces on its TCP edge. */
export interface DoorGrantGate {
  /** The issuer's published verification keys (selected per grant by `kid`). */
  readonly keys: IssuerKeys;
  /** The room id permitted to present grants to THIS door (audience binding). */
  readonly audience: string;
}

/**
 * Build the `RequestAuthorizer` for a door's TCP edge: a request is served iff
 * it carries a `grant` that is (a) minted for `door`, (b) audience-bound to us,
 * (c) unexpired, and (d) signed by a known published issuer key. A unix caller
 * never reaches this — the kernel already authenticated it.
 */
export function buildDoorAuthorizer(
  door: string,
  gate: DoorGrantGate,
  now?: () => number,
): RequestAuthorizer {
  return signedGrantAuthorizer({
    keys: gate.keys,
    audience: gate.audience,
    door,
    verifyWith: ed25519VerifyWith,
    ...(now ? { now } : {}),
  });
}

/** Injectable seams for {@link resolveDoorGrantGate} (tests pass fakes). */
export interface ResolveGateDeps {
  env?: (key: string) => string | undefined;
  readFile?: (path: string) => string;
}

/**
 * Resolve a door's gate from the ambient environment, or `null` when
 * unconfigured (⇒ no TCP enforcement — kept loopback-bound by the publish-side
 * safety fix). Both the audience and the issuer keys must be present; one
 * without the other is a misconfiguration that resolves to `null` (the caller
 * WARNs). The keys value is inline JSON, or `@<path>` to a JSON file holding an
 * `IssuerKeys` object.
 *
 * @param audienceEnv env var holding the audience (e.g. `KEEPERD_GRANT_AUDIENCE`)
 * @param keysEnv     env var holding the issuer keys (e.g. `KEEPERD_ISSUER_KEYS`)
 */
export function resolveDoorGrantGate(
  audienceEnv: string,
  keysEnv: string,
  deps: ResolveGateDeps = {},
): DoorGrantGate | null {
  const env = deps.env ?? getEnv;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));

  const audience = env(audienceEnv);
  const keysRaw = env(keysEnv);
  if (!audience || !keysRaw) return null;

  const json = keysRaw.startsWith("@") ? readFile(keysRaw.slice(1)) : keysRaw;
  let keys: IssuerKeys;
  try {
    keys = JSON.parse(json) as IssuerKeys;
  } catch {
    throw new Error(`${keysEnv}: not valid JSON IssuerKeys`);
  }
  if (!Array.isArray(keys.keys) || keys.keys.length === 0) {
    throw new Error(`${keysEnv}: expected { keys: [{ kid, publicKeyPem }, ...] }`);
  }
  return { keys, audience };
}
