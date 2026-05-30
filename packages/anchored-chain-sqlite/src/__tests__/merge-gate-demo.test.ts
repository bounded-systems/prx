import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  digestManifest,
  openAnchoredChain,
  validateDerivation,
  type ContractId,
  type ContractRegistry,
  type Derivation,
  type Digest,
  type AnchoredChainStore,
  type VerdictResult,
} from '@bounded-systems/anchored-chain-sqlite';

// Demonstrative proof for the anchored-chain claim
// "artifacts license transitions; the merge gate is a verifier".
//   docs/anchored-chain/references/foundational/in-toto-slsa.md
//
// This test wires a coding-agent chain
//   issue → plan → patch → {test_run, review_evidence} → merge_decision
// and shows the merge gate REFUSING the transition until a review-evidence
// artifact with status=approved exists in the graph, then LICENSING it once
// it does. It uses only the shipped `validateDerivation` DAG walk plus a
// contract registry — no new production code. The registry consults the
// artifact graph (the store / fixtures), never a caller-supplied payload,
// which is the same "no ambient authority" shape the guards enforce at the
// type level (see __tests__/guards.test.ts, "store is authoritative").

let store: AnchoredChainStore;

beforeEach(() => {
  store = openAnchoredChain(':memory:');
});

afterEach(() => {
  store.close();
});

const D = (s: string) => `sha256:${s.padEnd(64, '0')}` as Digest;
const C = (s: string) => s as ContractId;

function mkDer(producer: string, inputs: Record<string, Digest>): Derivation {
  const manifest = {
    producer,
    inputs,
    outputs: { out: D(`${producer}-out`) },
    contracts:
      producer === 'agent:reviewer'
        ? (['anchored/review-approved'] as const)
        : producer === 'gate:merge'
          ? (['anchored/merge-requires-review'] as const)
          : ([] as const),
    params: {},
  } as const;
  return { derivationId: digestManifest(manifest), manifest, ts: 0 };
}

/**
 * The merge gate's contract authority. Both validators read only the
 * artifact graph (the `byId` / `reviewStatus` fixtures), so a caller cannot
 * manufacture a merge license by lying — exactly the licensing semantics the
 * anchored-chain docs claim.
 */
function mkGateRegistry(args: {
  byId: Map<Digest, Derivation>;
  reviewNodes: Set<Digest>;
  reviewStatus: Map<Digest, string>;
}): ContractRegistry {
  const { byId, reviewNodes, reviewStatus } = args;
  const validators: Record<string, (id: Digest) => VerdictResult> = {
    // Licenses the merge transition iff a review_evidence artifact is among
    // the merge_decision's declared inputs. Absence = unlicensed transition.
    'anchored/merge-requires-review': (id) => {
      const der = byId.get(id);
      if (!der) return { ok: false, reason: 'merge_decision derivation missing' };
      const hasReview = Object.values(der.manifest.inputs).some((d) =>
        reviewNodes.has(d),
      );
      return hasReview
        ? { ok: true }
        : {
            ok: false,
            reason:
              'merge gate: no review_evidence among inputs — transition unlicensed',
          };
    },
    // The review_evidence artifact itself only validates when approved.
    'anchored/review-approved': (id) => {
      const status = reviewStatus.get(id) ?? '<absent>';
      return status === 'approved'
        ? { ok: true }
        : { ok: false, reason: `review status=${status} (need approved)` };
    },
  };
  return {
    getValidator(contractId: ContractId) {
      return (id: Digest) => {
        const v = validators[contractId as string];
        if (!v) throw new Error(`no validator for ${contractId as string}`);
        return v(id);
      };
    },
  };
}

interface BuiltChain {
  merge: Derivation;
  review: Derivation | null;
  byId: Map<Digest, Derivation>;
  reviewNodes: Set<Digest>;
  reviewStatus: Map<Digest, string>;
}

async function buildCodingChain(opts: {
  includeReview: boolean;
  reviewStatus?: string;
}): Promise<BuiltChain> {
  const issue = mkDer('source:issue', {});
  const plan = mkDer('agent:planner', { issue: issue.derivationId });
  const patch = mkDer('agent:executor', { plan: plan.derivationId });
  const testRun = mkDer('runner:tests', { patch: patch.derivationId });

  const byId = new Map<Digest, Derivation>();
  const reviewNodes = new Set<Digest>();
  const reviewStatus = new Map<Digest, string>();

  let review: Derivation | null = null;
  const mergeInputs: Record<string, Digest> = {
    patch: patch.derivationId,
    test_run: testRun.derivationId,
  };
  if (opts.includeReview) {
    review = mkDer('agent:reviewer', { patch: patch.derivationId });
    mergeInputs.review = review.derivationId;
    reviewNodes.add(review.derivationId);
    reviewStatus.set(review.derivationId, opts.reviewStatus ?? 'approved');
  }
  const merge = mkDer('gate:merge', mergeInputs);

  for (const d of [issue, plan, patch, testRun, review, merge]) {
    if (d === null) continue;
    await store.derivations.append(d);
    byId.set(d.derivationId, d);
  }

  return { merge, review, byId, reviewNodes, reviewStatus };
}

describe('merge gate is a verifier (anchored-chain claim #2)', () => {
  test('REFUSES merge when no review_evidence exists in the graph', async () => {
    const chain = await buildCodingChain({ includeReview: false });
    const registry = mkGateRegistry(chain);

    const verdict = await validateDerivation(
      chain.merge.derivationId,
      store.derivations,
      registry,
    );

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.failedAt).toBe(chain.merge.derivationId);
    expect(verdict.contract).toBe(C('anchored/merge-requires-review'));
    expect(verdict.reason).toMatch(/unlicensed/);
  });

  test('REFUSES merge when review_evidence exists but is not approved', async () => {
    const chain = await buildCodingChain({
      includeReview: true,
      reviewStatus: 'changes_requested',
    });
    const registry = mkGateRegistry(chain);

    const verdict = await validateDerivation(
      chain.merge.derivationId,
      store.derivations,
      registry,
    );

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    // Provenance points at the review node, not the merge node: the gate
    // admitted the transition's shape, the review artifact failed its own
    // contract during the DAG walk.
    expect(verdict.failedAt).toBe(chain.review!.derivationId);
    expect(verdict.contract).toBe(C('anchored/review-approved'));
    expect(verdict.reason).toMatch(/changes_requested/);
  });

  test('LICENSES merge once an approved review_evidence exists', async () => {
    const chain = await buildCodingChain({
      includeReview: true,
      reviewStatus: 'approved',
    });
    const registry = mkGateRegistry(chain);

    const verdict = await validateDerivation(
      chain.merge.derivationId,
      store.derivations,
      registry,
    );

    expect(verdict).toEqual({ ok: true });
  });
});
