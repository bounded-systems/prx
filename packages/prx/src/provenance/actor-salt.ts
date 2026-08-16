// prx-g88.4 (C4) — the intake ⊗ actor salt (docs/capability-orchestrator.md §3).
// The layered identity that the ephemeral isolation (C5) addresses by:
//
//   unit_salt  = H(<unit>:source@pinned digest)        — minted at INTAKE
//   actor_salt = H(unit_salt ⊗ actor_identity)         — derived by the ACTOR
//
// Intake mints the unit-root salt from the pinned-source digest (the chain root):
// per-unit, unforgeable (bound to the exact source content), travels with the
// unit. Each actor derives its own salt from (unit_salt, actor_identity), where
// actor_identity = actor@sha256(authority-contract) (`actorSigningIdentity`) —
// deterministic and recomputable by a verifier, giving each actor an isolated,
// non-shareable worktree/branch (C5). Neither half alone works: actor-only isn't
// bound to a real intake (forgeable unit association); intake-only is one shared
// context across all actors. The salt governs isolation/addressing only — NOT
// key material (that stays HMAC(master, identity) in keymaker).

import { createHash } from "node:crypto";
import { actorSigningIdentity } from "./actor-identity.ts";

/** Short, addressable salt length (git-short-sha style) for worktree/branch names. */
export const SALT_LENGTH = 12;

function sha256hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * The unit-root salt, minted at intake from the pinned-source digest. Bound to
 * the exact source content, so it cannot be fabricated for a unit that never
 * entered via intake. Domain-separated so it can't collide with other sha256 uses.
 */
export function unitSalt(sourcePinnedDigest: string): string {
  if (sourcePinnedDigest.trim().length === 0) {
    throw new Error(
      "unitSalt: sourcePinnedDigest must be non-empty (mint at intake from source@pinned)",
    );
  }
  return sha256hex(`prx/unit-salt/${sourcePinnedDigest}`).slice(0, SALT_LENGTH);
}

/**
 * The per-actor salt = H(unit_salt ⊗ actor_identity). `actor_identity` is
 * `actor@sha256(authority-contract)` — it rotates with the actor's powers, not
 * its code — so the salt (hence the actor's worktree/branch) changes if the
 * actor's authority changes. Two different actors on the same unit get DIFFERENT
 * salts (no sharing); the same actor on different units gets different salts
 * (bound to intake).
 */
export function actorSalt(unitSaltValue: string, actor: string): string {
  if (unitSaltValue.trim().length === 0) {
    throw new Error("actorSalt: unitSaltValue must be non-empty");
  }
  const identity = actorSigningIdentity(actor);
  return sha256hex(`prx/actor-salt/${unitSaltValue}/${identity}`).slice(0, SALT_LENGTH);
}

/** Convenience: derive an actor's salt straight from the pinned-source digest. */
export function actorSaltForSource(sourcePinnedDigest: string, actor: string): string {
  return actorSalt(unitSalt(sourcePinnedDigest), actor);
}

// --- Addressing derived from the salt (the names C5's lifecycle creates/destroys).

/** The ephemeral worktree directory name for an actor: `<actor>-<actor_salt>`. */
export function actorWorktreeDirName(actor: string, actorSaltValue: string): string {
  return `${actor}-${actorSaltValue}`;
}

/** The ephemeral working branch for an actor on a unit: `<actor>/<unit>-<actor_salt>`. */
export function actorBranchName(actor: string, unit: string, actorSaltValue: string): string {
  return `${actor}/${unit}-${actorSaltValue}`;
}
