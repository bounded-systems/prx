// `ci` projection state for `.pr/local` (GH-352).
//
// The local, freshness-aware read of CI provenance for the current HEAD: the
// merge-guard verdict (`verified` / `unsigned` / `unchecked`) PLUS whether the
// recorded green still covers the current working tree (`fresh` / `stale` /
// `unknown`). Where the merge-guard's `isStale` is a defensive no-op (it gates a
// specific commit, which pins the tree), the *local* projection is exactly where
// staleness is meaningful: HEAD may have advanced, or the worktree changed, since
// CI ran — so the surfaced green could be stale.
import type { Derivation, DerivationStore, Digest, Verifier } from "@bounded-systems/anchored-chain";

import { projectProvenanceAxis } from "../provenance/merge-guard.ts";

export type CiVerdict = "verified" | "unsigned" | "unchecked";
export type CiFreshness = "fresh" | "stale" | "unknown";

export interface CiProvenanceState {
  /** The merge-guard provenance axis for the commit. */
  readonly verdict: CiVerdict;
  /** Whether the recorded CI derivations still cover the current tree. */
  readonly freshness: CiFreshness;
}

/** The default when no ledger/commit is resolvable (CI provenance unknown). */
export const DEFAULT_CI_PROVENANCE_STATE: CiProvenanceState = {
  verdict: "unchecked",
  freshness: "unknown",
};

export interface CiProvenanceStateDeps {
  readonly store: {
    readonly derivations: Pick<DerivationStore, "derivationsByOutput" | "get">;
    readonly lineage: {
      isStale(id: Digest, currentRefs: Readonly<Record<string, Digest>>): Promise<boolean>;
    };
  };
  readonly commit: string;
  /** The CURRENT working-tree refs (`{ tree, lock, toolchain }`) to test freshness against. */
  readonly currentRefs: Readonly<Record<string, Digest>>;
  readonly verifier: Verifier | null;
  readonly verifierFor?: (derivation: Derivation) => Verifier | null;
}

/**
 * Resolve the local CI provenance state for a commit: the merge-guard verdict
 * plus a freshness signal computed by `isStale` against the current tree refs.
 * `verdict` is computed with enforcement on so the projection reflects the real
 * signed state (it is a read, never a gate).
 */
export async function resolveCiProvenanceState(
  deps: CiProvenanceStateDeps,
): Promise<CiProvenanceState> {
  const verdict = (await projectProvenanceAxis(deps.commit, {
    store: deps.store.derivations,
    verifier: deps.verifier,
    ...(deps.verifierFor ? { verifierFor: deps.verifierFor } : {}),
    enforce: true,
  })) as CiVerdict;

  const ids = await deps.store.derivations.derivationsByOutput(
    `gitCommit:${deps.commit}` as Digest,
  );
  let freshness: CiFreshness = "unknown";
  if (ids.length > 0) {
    let stale = false;
    for (const id of ids) {
      if (await deps.store.lineage.isStale(id, deps.currentRefs)) {
        stale = true;
        break;
      }
    }
    freshness = stale ? "stale" : "fresh";
  }
  return { verdict, freshness };
}
