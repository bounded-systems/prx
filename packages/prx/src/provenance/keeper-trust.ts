/**
 * Resolve the **keeper trust key** — the public key prx verifies door-keeper's L3
 * attestation against (Phase B.2). Per the recorded hardening decision, the
 * anchor is **operator-supplied and NEVER derived from the actor**: no
 * `getPublicKey` (the actor asserting its own key is circular), no image-bind
 * (still trusts the build). The operator sets it out-of-band; if it's absent the
 * caller fails closed.
 *
 * `PRX_KEEPER_PUBKEY` is either a PEM literal or a path to a PEM file (mirrors
 * `provenance/config.ts`'s env + injected-`read` pattern, so it stays seam-safe
 * and offline-testable). Image-bind / TOFU-pin, if ever added, are explicit
 * opt-ins layered ABOVE this — never a silent fallback.
 */

import { readFileSync } from "node:fs";

import { getEnv } from "@bounded-systems/env";

/** Env var carrying the operator's keeper trust key (a PEM, or a path to one). */
export const KEEPER_PUBKEY_ENV = "PRX_KEEPER_PUBKEY";

type EnvReader = (key: string) => string | undefined;

function looksLikePem(s: string): boolean {
  return s.trimStart().startsWith("-----BEGIN");
}

/**
 * The operator-supplied keeper public key (PEM), or `null` when none is
 * configured or it can't be read — the caller fails closed on `null` under
 * `requireSigned`. The key is NEVER fetched from the actor or its image.
 */
export function resolveKeeperTrustKey(
  env: EnvReader = getEnv,
  read: (path: string) => string = (p) => readFileSync(p, "utf8"),
): string | null {
  const raw = env(KEEPER_PUBKEY_ENV);
  if (raw === undefined || raw.trim() === "") return null; // unset → fail closed
  if (looksLikePem(raw)) return raw; // a PEM literal
  // Otherwise treat it as a path to a PEM file.
  try {
    const contents = read(raw);
    return looksLikePem(contents) ? contents : null;
  } catch {
    return null; // configured but unreadable / not a PEM → fail closed
  }
}
