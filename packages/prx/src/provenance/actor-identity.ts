/**
 * Per-actor signing identity (prx-keymaker, epic prx-997).
 *
 * The provenance chain signs with one key today; this is the pure, secretless
 * foundation for giving each actor its OWN signing identity. Three pieces, none
 * of which touch a private key on its own:
 *
 *   1. {@link actorIdentity} — `<actor>@<digest>`, where the digest is a hash of
 *      the actor's AUTHORITY CONTRACT (its capability declaration in
 *      `SESSION_PROFILES`), not its code. So the identity rotates exactly when
 *      the actor's powers change (widen `allowedTools`, add a dispatch target),
 *      and stays stable across ordinary code churn.
 *   2. {@link deriveActorKeypair} — a deterministic KDF: the actor's keypair is
 *      `HMAC-SHA256(masterSecret, "prx/actor/" + identity)` (32 bytes = an
 *      ed25519 seed). The identity is the KDF salt, so a changed contract →
 *      changed identity → a DIFFERENT key from the SAME secret (free rotation).
 *      The secret is a deployment input (sops/agenix), never stored here.
 *   3. {@link buildActorTrustMap} — derive every actor's PUBLIC half into the
 *      trust map the verifier consults. This is the secretless "keymaker
 *      register" operation: it publishes who-is-who, holding no private key.
 *
 * Security shape: the private capability stays decentralized (only an actor,
 * with its own secret, derives its signing key); the keymaker only ever produces
 * public material. No god-actor.
 */
import { ed25519Keyid, importEd25519PrivateKey } from "@bounded-systems/anchored-chain";
import { createHash, createHmac, createPublicKey, type KeyObject } from "node:crypto";

import {
  SESSION_PROFILES,
  sessionProfileNames,
  type SessionProfileName,
} from "../machine/runtime_profiles.ts";

/**
 * The authority-relevant subset of an actor's profile — what makes it a security
 * principal. Excludes `banner` (documentation) and everything dynamic (system
 * prompt, work-unit id): those shape behavior, but the allow/deny lists are the
 * hard authority boundary, and they are what a verifier's trust decision rests
 * on. Arrays are sorted so order is not part of the identity.
 */
export interface ActorAuthorityContract {
  actor: string;
  binding: string;
  allowedTools: string[];
  disallowedTools: string[];
  allowedActors: string[];
  disallowedActors: string[];
  allowedDispatchTargets: string[];
}

export function actorAuthorityContract(actor: SessionProfileName): ActorAuthorityContract {
  const p = SESSION_PROFILES[actor];
  const sort = (xs: readonly string[]): string[] => [...xs].sort();
  return {
    actor: p.name,
    binding: p.binding,
    allowedTools: sort(p.allowedTools),
    disallowedTools: sort(p.disallowedTools),
    allowedActors: sort(p.allowedActors),
    disallowedActors: sort(p.disallowedActors),
    allowedDispatchTargets: sort(p.allowedDispatchTargets as readonly string[]),
  };
}

/**
 * Canonical bytes of a contract: a flat, fixed-key-order, sorted-array object, so
 * the JSON is reproducible across processes. `digestOfContract` is the pure core
 * — exposed so the digest can be tested over a synthetic contract.
 */
function canonicalContract(c: ActorAuthorityContract): string {
  return JSON.stringify({
    actor: c.actor,
    binding: c.binding,
    allowedTools: [...c.allowedTools].sort(),
    disallowedTools: [...c.disallowedTools].sort(),
    allowedActors: [...c.allowedActors].sort(),
    disallowedActors: [...c.disallowedActors].sort(),
    allowedDispatchTargets: [...c.allowedDispatchTargets].sort(),
  });
}

export function digestOfContract(c: ActorAuthorityContract): string {
  return createHash("sha256").update(canonicalContract(c)).digest("hex");
}

/** Short identity tag length (git-short-sha style). */
export const ACTOR_DIGEST_LENGTH = 12;

/** The full sha256 of an actor's authority contract. */
export function actorAuthorityDigest(actor: SessionProfileName): string {
  return digestOfContract(actorAuthorityContract(actor));
}

/** `<actor>@<short-digest>` — the versioned signing identity. */
export function actorIdentity(actor: SessionProfileName): string {
  return `${actor}@${actorAuthorityDigest(actor).slice(0, ACTOR_DIGEST_LENGTH)}`;
}

function isSessionProfile(actor: string): actor is SessionProfileName {
  return (sessionProfileNames as readonly string[]).includes(actor);
}

/**
 * The signing identity for ANY actor string (e.g. the ambient
 * `getAuditRuntimeContext().actor`). A session-profile actor gets its full
 * authority-contract digest (rotates with its powers); an actor without a
 * profile — `keeper` (the git owner), a future `checks`/`verifier` — gets a
 * name-bound identity `<actor>@<sha256("prx-actor:"+name)>`. That is stable and
 * distinct per actor (enough for per-actor key derivation); binding keeper to
 * its policy-role contract is a follow-up. An empty actor falls back to
 * `unknown` so a key is always derivable.
 */
export function actorSigningIdentity(actor: string): string {
  const name = actor.trim().length > 0 ? actor.trim() : "unknown";
  if (isSessionProfile(name)) return actorIdentity(name);
  const digest = createHash("sha256")
    .update(`prx-actor:${name}`)
    .digest("hex")
    .slice(0, ACTOR_DIGEST_LENGTH);
  return `${name}@${digest}`;
}

export interface DerivedActorKeypair {
  privateKey: KeyObject;
  publicKey: KeyObject;
  keyid: string;
  /** base64 raw 32-byte public point — the trust-map value. */
  pointBase64: string;
}

const KDF_INFO_PREFIX = "prx/actor/";

/**
 * Deterministically derive an actor's ed25519 keypair from a master secret + its
 * identity. Pure given its inputs: the same (secret, identity) always yields the
 * same key, and a different identity (rotated contract) yields a different key
 * from the same secret. HMAC-SHA256 produces exactly a 32-byte ed25519 seed.
 */
export function deriveActorKeypair(masterSecret: Buffer, identity: string): DerivedActorKeypair {
  const seed = createHmac("sha256", masterSecret)
    .update(KDF_INFO_PREFIX + identity)
    .digest(); // 32 bytes
  const privateKey = importEd25519PrivateKey(seed.toString("base64"));
  const publicKey = createPublicKey(privateKey);
  const keyid = ed25519Keyid(publicKey);
  const jwkX = (publicKey.export({ format: "jwk" }) as { x?: string }).x;
  const pointBase64 = jwkX ? Buffer.from(jwkX, "base64url").toString("base64") : "";
  return { privateKey, publicKey, keyid, pointBase64 };
}

export interface TrustMapEntry {
  /** `<actor>@<digest>` — the versioned identity the signature attests. */
  identity: string;
  /** The DSSE envelope's keyid (binds the key to the signature). */
  keyid: string;
  /** `ed25519:<base64 point>` — the public verification key. */
  pubkey: string;
}

/**
 * The secretless "keymaker register" core: derive every actor's PUBLIC key into
 * the trust map a verifier consults (`actor → { identity, keyid, pubkey }`).
 * Takes the master secret to *derive* the public halves, but emits only public
 * material — the private keys never leave this function.
 */
export function buildActorTrustMap(masterSecret: Buffer): Record<string, TrustMapEntry> {
  const map: Record<string, TrustMapEntry> = {};
  for (const actor of sessionProfileNames) {
    const identity = actorIdentity(actor);
    const kp = deriveActorKeypair(masterSecret, identity);
    map[actor] = {
      identity,
      keyid: kp.keyid,
      pubkey: `ed25519:${kp.pointBase64}`,
    };
  }
  return map;
}
