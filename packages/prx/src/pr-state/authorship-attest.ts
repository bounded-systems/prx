// `keeper commit` → keeperd's signed L3 records AI-vs-human authorship under
// `predicate.authorship` (door-keeper, GitAI Phase 2): the model's self-reported
// claim reconciled against the actually-staged diff. This projects that
// reconciled verdict into prx's provenance ledger as a `prx.dev/authorship/v1`
// derivation so the authorship/bypass record is content-addressed, queryable,
// and publishable to the trust ledger (prx-sfco) — mirroring `scout-attest.ts` /
// `ci-attest.ts`.
//
// It does NOT re-sign the authorship: keeperd's signed L3 envelope is carried as
// a content-addressed `resolvedDependencies` input (`l3`, by its sha256), so the
// commit-key signature remains the authority and this derivation is only the
// index/lineage entry. `invalidate.descendants(l3Digest)` answers "what indexed
// this L3?".
//
// The high-signal set is the entries whose `divergent` is non-empty: files
// staged but never claimed by the model = a bypass keeperd detected.
import type { Derivation } from "@bounded-systems/anchored-chain";

import { type AttestDeps, persistAttestation } from "../provenance/attest.ts";

/** The build type for a prx authorship-ledger entry — projects keeperd's L3
 *  `predicate.authorship` reconciliation into the prx provenance chain. */
export const AUTHORSHIP_BUILD_TYPE = "https://prx.dev/authorship/v1";

/**
 * keeperd's reconciled authorship verdict (door-keeper `predicate.authorship`):
 * the model's claim intersected with / subtracted from the actually-staged diff.
 * All entries are repo-relative paths.
 */
export interface AuthorshipClaim {
  /** The model label the box self-reported, when supplied. */
  readonly model?: string;
  /** Claimed ∩ actually-staged — files the model authored that landed. */
  readonly aiAuthored: readonly string[];
  /** Staged but NOT claimed — a bypass (human / untracked edit). */
  readonly divergent: readonly string[];
  /** Claimed but NOT staged — never landed. */
  readonly stale: readonly string[];
}

/** Inputs for {@link attestAuthorship}. */
export interface AuthorshipAttestInput {
  /** The commit the L3 attests (the subject). A 40-hex git oid. */
  readonly commitSha: string;
  /** sha256 of keeperd's signed L3 envelope — carried as the `l3` input so the
   *  keeper signature is preserved by-reference rather than re-signed here. */
  readonly l3EnvelopeDigest: string;
  /** keeperd's reconciled verdict, recorded in the derivation's params. */
  readonly authorship: AuthorshipClaim;
}

/**
 * Record a `authorship/v1` derivation projecting a keeperd L3 authorship
 * reconciliation into the prx provenance ledger.
 *
 * Subject = the commit (`gitCommit`); the keeperd L3 envelope is the `l3`
 * `resolvedDependencies` input (by sha256). Idempotent: `persistAttestation`
 * content-addresses the manifest, so the same (commit, L3, verdict) returns the
 * stored derivation without a duplicate append. Pure over `deps` (signer +
 * store); the CLI resolves the live signer and opens the ledger.
 */
export async function attestAuthorship(
  deps: AttestDeps,
  input: AuthorshipAttestInput,
): Promise<Derivation> {
  const { commitSha, l3EnvelopeDigest, authorship } = input;
  return persistAttestation(deps, {
    buildType: AUTHORSHIP_BUILD_TYPE,
    subject: [{ name: "commit", digest: { gitCommit: commitSha } }],
    resolvedDependencies: [{ name: "l3", digest: { sha256: l3EnvelopeDigest } }],
    externalParameters: {
      ...(authorship.model ? { model: authorship.model } : {}),
      aiAuthored: [...authorship.aiAuthored],
      divergent: [...authorship.divergent],
      stale: [...authorship.stale],
    },
  });
}
