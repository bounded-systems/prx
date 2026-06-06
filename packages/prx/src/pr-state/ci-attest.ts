// `prx ci` → signed `checks/v1` attestations (GH-352).
//
// A green `prx ci` run should not be an ephemeral log line — it is evidence
// that a specific tree passed its checks. This records that evidence in the
// anchored chain by reusing the EXACT sign+append path the pilot's verify step
// uses (`provenance/attest.ts` `persistAttestation`, build type `checks/v1`):
// one DSSE-signed `Derivation` per passed phase, whose subject is the commit
// under test. So a `prx ci` green and a pilot green land identical-shaped,
// merge-guard-readable attestations in one ledger — no parallel CI shape.
//
// Fail-closed by construction: the caller only invokes this on a clean run, so
// the absence of a `checks/v1` for a commit means "not verified", mirroring
// `attestingChecks` (which signs only on `status === 0`).
import type { Derivation } from "@bounded-systems/anchored-chain";

import { type AttestDeps, CHECKS_BUILD_TYPE, persistAttestation } from "../provenance/attest.ts";

import type { CiPhase } from "./local-ci.ts";

/** The surface tag recorded in the attestation params, distinguishing a
 *  `prx ci`-emitted `checks/v1` from the pilot's executor-emitted one. */
export const CI_ATTEST_SURFACE = "prx ci";

/**
 * Record one signed `checks/v1` derivation per passed phase, keyed on the
 * commit under test. Idempotent: `persistAttestation` content-addresses the
 * manifest (no timestamp inside the id), so re-recording the same
 * `(commit, phase)` returns the stored derivation without a duplicate append.
 *
 * Pure over its `deps` (signer + store): the CLI resolves the live signer and
 * opens the canonical ledger; tests pass a fixed keypair signer and a fake
 * store. Each phase yields a DISTINCT derivation (the `phase` param feeds the
 * manifest digest), so a five-phase green produces five attestations sharing
 * one subject commit.
 */
export async function attestCiPhases(
  deps: AttestDeps,
  commit: string,
  phases: readonly CiPhase[],
): Promise<Derivation[]> {
  const recorded: Derivation[] = [];
  for (const phase of phases) {
    recorded.push(
      await persistAttestation(deps, {
        buildType: CHECKS_BUILD_TYPE,
        subject: [{ name: "checks", digest: { gitCommit: commit } }],
        externalParameters: { surface: CI_ATTEST_SURFACE, phase },
      }),
    );
  }
  return recorded;
}
