// `prx ci` → a signed, content-addressed CI derivation (GH-352).
//
// Supersedes the input-less `checks/v1` emission: that recorded a *signed vouch*
// keyed on the commit (empty `inputs`, `gitCommit:` subject) — a bucket-B
// attestation that the chain's lineage/`isStale`/`invalidate` machinery can't
// reason about. This records the SAME signed SLSA/DSSE envelope (so the
// merge-guard's commit-keyed verify path is unchanged) but with the **content
// digests of what was validated as `inputs`** — `tree`/`lock`/`toolchain`,
// `sha256:`-addressed. That flips the record into a bucket-A chain node:
//
//   inputs { tree, lock, toolchain }  →  output { commit }   (signed, per phase)
//
// so `lineage.isStale(id, { tree: currentTree })` is finally meaningful ("does
// this green still cover HEAD's tree?"), `invalidate.descendants(oldTree)` finds
// the CI work that validated a superseded tree, and CI composes with the rest of
// the content-addressed chain (e.g. scout reads) instead of being an island.
//
// Reuses `persistAttestation` wholesale: the commit stays the SLSA subject (→
// the `gitCommit:<oid>` output the merge-guard reverse-looks-up), the materials
// become `resolvedDependencies` (→ the manifest `inputs`). Fail-closed by
// construction: the caller invokes this only on a clean run, so absence of a
// derivation for a tree ≡ "not verified".
import type { Derivation, Digest } from "@bounded-systems/anchored-chain";
import { sha256BareHex } from "@bounded-systems/cas";

import { type AttestDeps, persistAttestation } from "../provenance/attest.ts";
import type { SlsaResourceDescriptor } from "../provenance/slsa.ts";

import type { CiPhase } from "./local-ci.ts";

/** The build type for a content-addressed CI-phase verdict. Distinct from the
 *  pilot's input-less `checks/v1`: this carries the validated tree as inputs. */
export const CI_PHASE_BUILD_TYPE = "https://prx.dev/ci/phase/v1";

/** The surface tag recorded in params (vs the pilot's executor-emitted checks). */
export const CI_ATTEST_SURFACE = "prx ci";

/** The named content inputs a CI verdict derives from — the bucket-A move.
 *  Each is a bare sha256 hex (no `sha256:` prefix); see {@link resolveCiInputs}. */
export interface CiInputs {
  /** sha256 over the HEAD tree identity — changes iff the worktree content does. */
  readonly tree: string;
  /** sha256 over the resolved lockfile bytes (`bun.lock`). */
  readonly lock: string;
  /** sha256 over the toolchain identity (e.g. `bun <version>`). */
  readonly toolchain: string;
}

/**
 * Derive the content digests a CI run consumed from their raw materials. Pure
 * (no IO): the CLI gathers `treeOid` (git), `lock` (the lockfile bytes), and a
 * `toolchain` string, and this hashes them into the `sha256:`-addressed inputs.
 * Prefixed before hashing so a tree oid and a toolchain string can never
 * collide in the address space.
 */
export function resolveCiInputs(raw: {
  readonly treeOid: string;
  readonly lock: string;
  readonly toolchain: string;
}): CiInputs {
  return {
    tree: sha256BareHex(`git-tree:${raw.treeOid}`),
    lock: sha256BareHex(raw.lock),
    toolchain: sha256BareHex(`toolchain:${raw.toolchain}`),
  };
}

function inputDescriptors(inputs: CiInputs): SlsaResourceDescriptor[] {
  return [
    { name: "tree", digest: { sha256: inputs.tree } },
    { name: "lock", digest: { sha256: inputs.lock } },
    { name: "toolchain", digest: { sha256: inputs.toolchain } },
  ];
}

/**
 * Record one signed CI-phase derivation per passed phase, keyed on the commit
 * under test, with the validated `tree`/`lock`/`toolchain` as content inputs.
 * Idempotent: `persistAttestation` content-addresses the manifest, so the same
 * `(inputs, commit, phase)` returns the stored derivation without a duplicate
 * append. Each phase yields a DISTINCT derivation (the `phase` param feeds the
 * manifest digest) sharing one subject commit and one input set.
 *
 * Pure over its `deps` (signer + store) and `inputs`: the CLI resolves the live
 * signer, opens the canonical ledger, and computes the inputs; tests pass a
 * fixed keypair signer, a store, and synthetic inputs.
 */
export async function attestCiPhases(
  deps: AttestDeps,
  inputs: CiInputs,
  commit: string,
  phases: readonly CiPhase[],
): Promise<Derivation[]> {
  const resolvedDependencies = inputDescriptors(inputs);
  const recorded: Derivation[] = [];
  for (const phase of phases) {
    recorded.push(
      await persistAttestation(deps, {
        buildType: CI_PHASE_BUILD_TYPE,
        subject: [{ name: "commit", digest: { gitCommit: commit } }],
        resolvedDependencies,
        externalParameters: { surface: CI_ATTEST_SURFACE, phase },
      }),
    );
  }
  return recorded;
}

/** The current value of a CI derivation's named inputs, for a freshness check:
 *  `store.lineage.isStale(id, currentCiRefs(inputs))` is true once HEAD's tree
 *  (or the lock/toolchain) no longer matches what the recorded run validated. */
export function currentCiRefs(inputs: CiInputs): Record<string, Digest> {
  return {
    tree: `sha256:${inputs.tree}` as Digest,
    lock: `sha256:${inputs.lock}` as Digest,
    toolchain: `sha256:${inputs.toolchain}` as Digest,
  };
}
