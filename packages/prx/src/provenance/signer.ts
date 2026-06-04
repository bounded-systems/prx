/**
 * The env-gated `Signer` / `Verifier` factory — the seam where a live signing
 * identity (and its matching verifier) is injected at the `@prx` capability
 * surface. Phase A (GH-2269) wired emission into production dispatch; GH-2249
 * adds fail-closed enforcement, which needs a *verifier* and a key that survives
 * across processes. The *choice* of key material is an ambient-environment
 * decision, so it lives here, on the machine side, and NEVER inside the
 * extractable `@bounded-systems/anchored-chain` core (whose import allowlist is
 * `node:crypto` + `@bounded-systems/cas`). The core stays a pure `Signer`/`Verifier` seam
 * (and the pure key-import helpers); this module is the only place that reads
 * `PRX_PROVENANCE_KEY` / `PRX_PROVENANCE_PUBKEY`.
 *
 * Signing modes, gated by `PRX_PROVENANCE_KEY` (see {@link resolveProvenanceSigner}):
 *   - `dev`            → a **stable, persisted** ed25519 `Signer` (offline, no
 *                        network). The reference signer for dev/offline runs and
 *                        tests. The keypair is generated on first use and stored
 *                        under the prx state dir (see {@link ./dev-key.ts}), so
 *                        every resolution returns the SAME identity ⇒ a dev-signed
 *                        derivation is verifiable cross-process. The matching
 *                        verifier auto-loads this key (GH-2282), so the full
 *                        sign → enforce → verify loop needs ZERO env wiring.
 *   - `ed25519:<b64>`  → a **stable** ed25519 `Signer` imported from base64 key
 *                        material (raw 32-byte seed or PKCS8 DER; see
 *                        {@link importEd25519PrivateKey}). This is the key whose
 *                        public half (`PRX_PROVENANCE_PUBKEY`) verifies emitted
 *                        derivations under `requireSigned`.
 *   - else             → `null` (no signing). Production keyless signing is
 *                        Sigstore (Fulcio/Rekor, needs network + OIDC) — spiked
 *                        in docs/spikes/sigstore-dsse-signing.md, not implemented
 *                        here. A future `sigstore` value still resolves to `null`.
 *
 * Returning `null` rather than throwing is deliberate: emission is best-effort
 * in Phase A (it must never fail `prx submit publish`), so an absent signer is
 * a quiet no-op, not an error. Enforcement (`requireSigned`, fail-closed) is the
 * publisher-tier / merge-guard concern of GH-2249 — a surface reads its own
 * `PRX_REQUIRE_SIGNED_DERIVATIONS` flag and resolves the verifier below.
 */

import {
  type Derivation,
  ed25519Keyid,
  ed25519Signer,
  ed25519Verifier,
  importEd25519PrivateKey,
  importEd25519PublicKey,
  type Signer,
  type Verifier,
} from "@bounded-systems/anchored-chain";
import { getAuditRuntimeContext } from "@bounded-systems/audit-context";
import { getEnv } from "@bounded-systems/env";
import { createPublicKey } from "node:crypto";

import { actorSigningIdentity, deriveActorKeypair } from "./actor-identity.ts";
import { loadOrCreateDevKeypair, loadOrCreateDevMaster } from "./dev-key.ts";
import { decodeSlsaStatement } from "./verify.ts";

/** The env var that selects the live signing identity (read only here). */
export const PROVENANCE_KEY_ENV = "PRX_PROVENANCE_KEY";

/** The env var carrying the public key that enforcement verifies against. */
export const PROVENANCE_PUBKEY_ENV = "PRX_PROVENANCE_PUBKEY";

/** The env var that turns on fail-closed signed-derivation enforcement. */
export const REQUIRE_SIGNED_ENV = "PRX_REQUIRE_SIGNED_DERIVATIONS";

/** The dev-mode sentinel: an offline, ephemeral ed25519 signer. */
export const DEV_SIGNER_MODE = "dev";

/**
 * prx-keymaker: per-actor dev signing. Like `dev`, but each actor signs with its
 * OWN key, derived from the persisted dev master + the actor's identity
 * (`deriveActorKeypair`). The signing actor is the AMBIENT one
 * (`getAuditRuntimeContext().actor`, the same source `builderId` uses), so a
 * process can only ever sign as itself. Self-verifying in dev: the verifier
 * resolves the actor from the statement's `builder.id` and derives the same key.
 */
export const ACTOR_DEV_SIGNER_MODE = "actor-dev";

/**
 * Prefix marking stable ed25519 key material on `PRX_PROVENANCE_KEY` /
 * `PRX_PROVENANCE_PUBKEY`. The prefix keeps the stable form distinct from the
 * `dev` / `sigstore` sentinels, so adding a stable signer does not reinterpret
 * an existing sentinel. Optional on the pubkey (no sentinel collides there).
 */
export const STABLE_KEY_PREFIX = "ed25519:";

/** Strip an optional `ed25519:` prefix, returning the bare base64 material. */
function stripStablePrefix(value: string): string {
  return value.startsWith(STABLE_KEY_PREFIX)
    ? value.slice(STABLE_KEY_PREFIX.length)
    : value;
}

/**
 * Resolve the live `Signer` from the ambient environment, or `null` when none
 * is configured. `env` is injectable so tests can drive the gating without
 * mutating the real process environment.
 *
 *   - `PRX_PROVENANCE_KEY=dev`           → ephemeral ed25519 `Signer`.
 *   - `PRX_PROVENANCE_KEY=ed25519:<b64>` → stable ed25519 `Signer` (verifiable).
 *   - unset / empty / anything else      → `null` (Sigstore prod path deferred).
 */
export function resolveProvenanceSigner(
  env: (key: string) => string | undefined = getEnv,
): Signer | null {
  const mode = env(PROVENANCE_KEY_ENV);
  if (mode === ACTOR_DEV_SIGNER_MODE) {
    // prx-keymaker: sign as the AMBIENT actor with its derived per-actor key —
    // the caller has no actor parameter to spoof.
    const actor = getAuditRuntimeContext().actor;
    const kp = deriveActorKeypair(loadOrCreateDevMaster(env), actorSigningIdentity(actor));
    return ed25519Signer(kp.privateKey, kp.keyid);
  }
  if (mode === DEV_SIGNER_MODE) {
    // GH-2282: stable, persisted dev identity (generate-on-first-use, reuse
    // thereafter) so a dev-signed derivation is verifiable cross-process — no
    // longer an ephemeral per-call keypair.
    const kp = loadOrCreateDevKeypair(env);
    return ed25519Signer(kp.privateKey, kp.keyid);
  }
  if (mode !== undefined && mode.startsWith(STABLE_KEY_PREFIX)) {
    const privateKey = importEd25519PrivateKey(stripStablePrefix(mode));
    // The keyid is derived from the public half so emitter and verifier agree
    // on it without a side channel — `ed25519Keyid` hashes the SPKI DER.
    const keyid = ed25519Keyid(createPublicKey(privateKey));
    return ed25519Signer(privateKey, keyid);
  }
  // Unset, empty, or a non-dev sentinel (e.g. a future "sigstore"): no live
  // signer until the prod keyless path lands. Emission becomes a fail-open no-op.
  return null;
}

/**
 * Resolve the `Verifier` that enforcement checks emitted derivations against,
 * or `null` when `PRX_PROVENANCE_PUBKEY` is unset/empty. The public key is
 * base64 material (raw 32-byte point or SPKI DER, optionally `ed25519:`-prefixed;
 * see {@link importEd25519PublicKey}). A malformed value throws — a misconfigured
 * enforcement key is a hard error, not a silent fail-open. `env` is injectable
 * for tests.
 */
export function resolveProvenanceVerifier(
  env: (key: string) => string | undefined = getEnv,
): Verifier | null {
  const material = env(PROVENANCE_PUBKEY_ENV);
  if (material !== undefined && material !== "") {
    // Explicit pubkey wins (unchanged): the operator-supplied verification key
    // for the stable `ed25519:<b64>` signer path.
    return ed25519Verifier(importEd25519PublicKey(stripStablePrefix(material)));
  }
  // GH-2282 dev fallback: when no explicit pubkey is configured but the signing
  // mode is `dev`, verify against the SAME persisted dev key the signer uses, so
  // dev enforcement self-verifies with zero env wiring. This is the only new env
  // coupling and it is strictly dev-scoped — prod/`ed25519:` paths still require
  // an explicit `PRX_PROVENANCE_PUBKEY`.
  if (env(PROVENANCE_KEY_ENV) === DEV_SIGNER_MODE) {
    return ed25519Verifier(loadOrCreateDevKeypair(env).publicKey);
  }
  return null;
}

/**
 * Whether fail-closed signed-derivation enforcement is on, from
 * `PRX_REQUIRE_SIGNED_DERIVATIONS`. Truthy values: `1`/`true`/`on`/`yes`
 * (case-insensitive); unset/empty/anything else ⇒ off (backward compatible).
 * `env` is injectable for tests.
 */
export function requireSignedDerivations(
  env: (key: string) => string | undefined = getEnv,
): boolean {
  const raw = env(REQUIRE_SIGNED_ENV);
  if (raw === undefined) return false;
  const v = raw.toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

/** Whether per-actor (`actor-dev`) signing/verification is the active mode. */
export function isActorDevMode(
  env: (key: string) => string | undefined = getEnv,
): boolean {
  return env(PROVENANCE_KEY_ENV) === ACTOR_DEV_SIGNER_MODE;
}

/** Parse the actor out of a builder id `prx://<actor>/<verb>`; null if malformed. */
export function actorFromBuilderId(id: string): string | null {
  const m = /^prx:\/\/([^/]+)\//.exec(id);
  return m ? m[1]! : null;
}

/**
 * prx-keymaker: the verifier for a SPECIFIC actor's signatures. In `actor-dev`
 * mode this derives the actor's public half from the dev master (self-verifying
 * with the per-actor signer); in any other mode it falls back to the single
 * configured verifier (stable per-actor verification via the trust map is a
 * later slice). `null` when no key is resolvable.
 */
export function resolveActorVerifier(
  actor: string,
  env: (key: string) => string | undefined = getEnv,
): Verifier | null {
  if (env(PROVENANCE_KEY_ENV) === ACTOR_DEV_SIGNER_MODE) {
    const kp = deriveActorKeypair(loadOrCreateDevMaster(env), actorSigningIdentity(actor));
    return ed25519Verifier(kp.publicKey);
  }
  return resolveProvenanceVerifier(env);
}

/**
 * prx-keymaker: resolve the verifier for a derivation by reading the actor out
 * of its signed statement's `builder.id` and picking that actor's key. This is
 * the per-derivation seam the merge-guard uses so each attestation is checked
 * against the key of the actor that *claims* to have produced it — the actor and
 * the signature must be the same identity. Returns `null` (fail-closed) when the
 * envelope is absent or the actor can't be parsed.
 */
export function resolveActorVerifierForDerivation(
  derivation: Pick<Derivation, "envelope">,
  env: (key: string) => string | undefined = getEnv,
): Verifier | null {
  if (derivation.envelope === undefined) return null;
  let actor: string | null;
  try {
    actor = actorFromBuilderId(
      decodeSlsaStatement(derivation.envelope).predicate.runDetails.builder.id,
    );
  } catch {
    return null;
  }
  if (actor === null) return null;
  return resolveActorVerifier(actor, env);
}
