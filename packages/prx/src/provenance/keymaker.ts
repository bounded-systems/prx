/**
 * prx-keymaker slice 4: the `prx keymaker` verbs.
 *
 * The keymaker is a deploy-time, SECRETLESS registrar — it computes identities
 * and PUBLIC keys and writes the trust map, but never signs and never emits a
 * private key (those stay in each actor's context). Three verbs:
 *
 *   digest <actor>  — the `actor@<digest>` identity (pure; no key, no secret).
 *   register        — derive every actor's PUBLIC key and write the trust map
 *                     (`~/.config/prx/config.json` provenance.trust). The
 *                     deploy-time "publish who-is-who".
 *   drift           — which actors' identities/keys changed since the trust map
 *                     was written (i.e. whose contract rotated and needs
 *                     re-registering).
 *
 * All effects (master, config read/write) are injected so the verbs are pure
 * functions of their deps — testable without touching real keys or files.
 *
 * Per-actor identities are the default; set `PRX_PROVENANCE_PER_ACTOR=off` to
 * select the single-key fallback (see provenance/signer.ts).
 */
import { actorSigningIdentity, buildActorTrustMap } from "./actor-identity.ts";

/** Injected effects for the registrar verbs. */
export interface KeymakerDeps {
  /** The signing master (its PUBLIC halves are derived; the secret never leaves). */
  master: () => Buffer;
  /** The trust map currently in config (`provenance.trust`). */
  readTrust: () => Record<string, string>;
  /** Persist the trust map to config (`provenance.trust`). */
  writeTrust: (trust: Record<string, string>) => void;
}

/** `actor@<digest>` for any actor. Pure — no key, no secret, no IO. */
export function keymakerDigest(actor: string): string {
  return actorSigningIdentity(actor);
}

/** Derive `actor → ed25519:<pub>` for every actor from the master (public only). */
export function deriveTrustMap(master: Buffer): Record<string, string> {
  const built = buildActorTrustMap(master);
  const trust: Record<string, string> = {};
  for (const [actor, entry] of Object.entries(built)) {
    trust[actor] = entry.pubkey;
  }
  return trust;
}

export interface RegisterResult {
  trust: Record<string, string>;
  /** Actors whose pubkey changed vs what was already in config. */
  changed: string[];
}

/** Recompute every actor's PUBLIC key and write the trust map. Returns what changed. */
export function keymakerRegister(deps: KeymakerDeps): RegisterResult {
  const before = deps.readTrust();
  const trust = deriveTrustMap(deps.master());
  const changed = Object.keys(trust)
    .filter((actor) => before[actor] !== trust[actor])
    .sort();
  deps.writeTrust(trust);
  return { trust, changed };
}

export interface DriftEntry {
  actor: string;
  /** "rotated" = key changed; "unregistered" = no trust-map entry yet. */
  reason: "rotated" | "unregistered";
}

/**
 * Report which actors have drifted from the registered trust map — their
 * contract rotated (new identity ⇒ new key) or they were never registered. An
 * empty result means the trust map is current.
 */
export function keymakerDrift(deps: KeymakerDeps): DriftEntry[] {
  const current = deriveTrustMap(deps.master());
  const configured = deps.readTrust();
  const drift: DriftEntry[] = [];
  for (const actor of Object.keys(current).sort()) {
    const pinned = configured[actor];
    if (pinned === undefined) drift.push({ actor, reason: "unregistered" });
    else if (pinned !== current[actor]) drift.push({ actor, reason: "rotated" });
  }
  return drift;
}
