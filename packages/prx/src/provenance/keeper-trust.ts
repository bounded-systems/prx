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

/** Env var carrying the operator's launcher trust key (a PEM, or a path to one). */
export const LAUNCHER_PUBKEY_ENV = "PRX_LAUNCH_PUBKEY";

/** Resolve an operator-supplied trust key (PEM literal or path) from `envVar`,
 *  or `null` when unset/unreadable/not-a-PEM. NEVER fetched from the actor. */
function resolveTrustKey(
  envVar: string,
  env: EnvReader,
  read: (path: string) => string,
): string | null {
  const raw = env(envVar);
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

/**
 * The operator-supplied **keeper** public key (PEM) — verifies the L3 write — or
 * `null` (the caller fails closed under `requireSigned`). NEVER from the actor.
 */
export function resolveKeeperTrustKey(
  env: EnvReader = getEnv,
  read: (path: string) => string = (p) => readFileSync(p, "utf8"),
): string | null {
  return resolveTrustKey(KEEPER_PUBKEY_ENV, env, read);
}

/**
 * The operator-supplied **launcher** public key (PEM) — verifies the L2 launch in
 * the capability chain — or `null`. Distinct guest/owner from the keeper (the
 * launching guest signs L2; the keeper signs L3). NEVER from the actor.
 */
export function resolveLauncherTrustKey(
  env: EnvReader = getEnv,
  read: (path: string) => string = (p) => readFileSync(p, "utf8"),
): string | null {
  return resolveTrustKey(LAUNCHER_PUBKEY_ENV, env, read);
}
