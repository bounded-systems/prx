/**
 * The merge-guard provenance projection (GH-2249, invariant I-PROV1).
 *
 * The read side of enforcement at the merge transition: given a UoW's head
 * commit, enumerate the `push/v1` derivations in the anchored-chain ledger that
 * attest it (output digest `gitCommit:<oid>`, via the reverse lookup
 * {@link DerivationStore.derivationsByOutput}) and re-verify each one's SLSA
 * envelope under the resolved `Verifier`. The verdict is the `provenance` axis
 * the synchronous merge gate (`canEnterReadyToMerge`) reads — so the gate stays
 * synchronous and free of ledger I/O, and the async verification lives here, at
 * the chain-check / audit surface that feeds the axis.
 *
 * Fail-closed, but deliberately NOT tightened to presence (that tightening is
 * out of scope; the publisher tier already fails closed when no derivation is
 * emitted). Concretely:
 *   - enforcement off ⇒ "unchecked" (never blocks — behaviour unchanged).
 *   - no derivation attests the commit ⇒ "unchecked": the merge gate is not
 *     newly tightened to *require* a derivation be present; absence is the
 *     publisher tier's concern, not a new merge-gate block.
 *   - a derivation IS present but cannot be verified (no verifier, missing
 *     record, absent/forged envelope, bad signature) ⇒ "unsigned": the only
 *     value that blocks the gate. A present-but-unverifiable attestation is a
 *     hard fail.
 *   - every present derivation verifies ⇒ "verified".
 */

import type {
  Derivation,
  DerivationStore,
  Digest,
  Verifier,
} from "@bounded-systems/anchored-chain";

import type { ProvenanceAxis } from "../machine/machines/workflow.ts";
import { verifySlsaDerivation } from "./verify.ts";

/** What the projection needs: the ledger reverse-lookup + fetch, plus a verifier. */
export interface ProvenanceProjectionDeps {
  /** The ledger, scoped to the reverse-lookup + per-id fetch it reads. */
  readonly store: Pick<DerivationStore, "derivationsByOutput" | "get">;
  /**
   * The verifier emitted derivations are checked against (from
   * `resolveProvenanceVerifier`). `null` when no public key is configured —
   * which, with derivations present and enforcement on, fails closed.
   */
  readonly verifier: Verifier | null;
  /**
   * prx-keymaker: per-actor verifier resolver. When present, each derivation is
   * checked against the key of the actor named in its own `builder.id` (via
   * `resolveActorVerifierForDerivation`) — the actor and the signature must be
   * the same identity. When absent, the single `verifier` above is used
   * (unchanged behavior). A resolver returning `null` for a present derivation
   * fails closed, exactly like a null `verifier`.
   */
  readonly verifierFor?: (derivation: Derivation) => Verifier | null;
  /**
   * Whether fail-closed enforcement is active (from `requireSignedDerivations`,
   * i.e. `PRX_REQUIRE_SIGNED_DERIVATIONS`). When false the projection is a no-op
   * that yields "unchecked".
   */
  readonly enforce: boolean;
}

/**
 * Compute the merge-guard provenance axis for a head commit. See the module
 * header for the fail-closed semantics. `gitCommit` is the bare commit oid; the
 * ledger output key is `gitCommit:<oid>` (the digest `attest.ts` records as a
 * `push/v1` subject).
 */
export async function projectProvenanceAxis(
  gitCommit: string,
  deps: ProvenanceProjectionDeps,
): Promise<ProvenanceAxis> {
  if (!deps.enforce) return "unchecked";

  const outputDigest = `gitCommit:${gitCommit}` as Digest;
  const ids = await deps.store.derivationsByOutput(outputDigest);

  // No attestation for this commit. Do NOT tighten the merge gate to require
  // one be present — that is out of scope and is the publisher tier's job.
  if (ids.length === 0) return "unchecked";

  // Derivations are present but we have no way to check them ⇒ fail closed.
  // (A per-actor resolver covers the key; a static verifier is the fallback.)
  if (deps.verifierFor === undefined && deps.verifier === null) return "unsigned";

  for (const id of ids) {
    const derivation: Derivation | null = await deps.store.get(id);
    if (derivation === null) return "unsigned"; // index points at a missing record
    // prx-keymaker: per-derivation verifier (the actor named in builder.id) when
    // a resolver is wired; else the single static verifier. A null resolution
    // for a present derivation is fail-closed.
    const verifier = deps.verifierFor ? deps.verifierFor(derivation) : deps.verifier;
    if (verifier === null || !(await verifySlsaDerivation(derivation, verifier))) {
      return "unsigned"; // no key for this actor, or absent/forged envelope, or bad sig
    }
  }
  return "verified";
}

/** The PR-machine event that drives the `provenance` region to a verdict. */
export type ProvenanceEvent =
  | { type: "PROVENANCE_VERIFIED" }
  | { type: "PROVENANCE_UNSIGNED" }
  | { type: "PROVENANCE_UNCHECKED" };

/** Map a verdict to the event that sets the machine's `provenance` axis. */
export function provenanceEventFor(axis: ProvenanceAxis): ProvenanceEvent {
  switch (axis) {
    case "verified":
      return { type: "PROVENANCE_VERIFIED" };
    case "unsigned":
      return { type: "PROVENANCE_UNSIGNED" };
    case "unchecked":
      return { type: "PROVENANCE_UNCHECKED" };
  }
}
