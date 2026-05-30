import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  digestManifest,
  openAnchoredChain,
  validateDerivation,
  validateRef,
  type ContractId,
  type ContractRegistry,
  type Derivation,
  type Digest,
  type AnchoredChainStore,
  type VerdictResult,
} from '@bounded-systems/anchored-chain-sqlite';

let store: AnchoredChainStore;

beforeEach(() => {
  store = openAnchoredChain(':memory:');
});

afterEach(() => {
  store.close();
});

const D = (s: string) => `sha256:${s.padEnd(64, '0')}` as Digest;
const C = (s: string) => s as ContractId;

function mkDer(args: {
  inputs: Record<string, Digest>;
  outputs: Record<string, Digest>;
  contracts: readonly string[];
}): Derivation {
  const manifest = {
    producer: 'noop',
    inputs: args.inputs,
    outputs: args.outputs,
    contracts: args.contracts,
    params: {},
  } as const;
  return {
    derivationId: digestManifest(manifest),
    manifest,
    ts: 0,
  };
}

function mkRegistry(
  map: Record<string, (id: Digest) => VerdictResult>,
  options: { onCall?: (contractId: string) => void } = {},
): ContractRegistry {
  return {
    getValidator(contractId: ContractId) {
      return (id: Digest, _bytes?: Uint8Array) => {
        options.onCall?.(contractId as string);
        const validator = map[contractId as string];
        if (!validator) {
          throw new Error(`no validator registered for ${contractId as string}`);
        }
        return validator(id);
      };
    },
  };
}

async function buildHappyChain(): Promise<{
  leaf: Derivation;
  mid: Derivation;
  top: Derivation;
}> {
  const aOut = D('aout');
  const bOut = D('bout');
  const cOut = D('cout');

  const leaf = mkDer({
    inputs: {},
    outputs: { out: aOut },
    contracts: ['c/A'],
  });
  const mid = mkDer({
    inputs: { prev: leaf.derivationId },
    outputs: { out: bOut },
    contracts: ['c/B'],
  });
  const top = mkDer({
    inputs: { prev: mid.derivationId },
    outputs: { out: cOut },
    contracts: ['c/C'],
  });

  await store.derivations.append(leaf);
  await store.derivations.append(mid);
  await store.derivations.append(top);

  await store.refs.cas({
    name: 'current',
    prevDigest: null,
    newDigest: top.derivationId,
    reason: 'init',
    ts: 0,
  });

  return { leaf, mid, top };
}

describe('validate', () => {
  test('happy path: 3-deep derivation chain → ok', async () => {
    await buildHappyChain();
    const registry = mkRegistry({
      'c/A': () => ({ ok: true }),
      'c/B': () => ({ ok: true }),
      'c/C': () => ({ ok: true }),
    });

    const verdict = await validateRef('current', store, registry);
    expect(verdict).toEqual({ ok: true });
  });

  test('tampered middle level fails at the middle node with provenance', async () => {
    const { mid } = await buildHappyChain();
    const registry = mkRegistry({
      'c/A': () => ({ ok: true }),
      'c/B': () => ({ ok: false, reason: 'tampered' }),
      'c/C': () => ({ ok: true }),
    });

    const verdict = await validateRef('current', store, registry);
    expect(verdict).toEqual({
      ok: false,
      failedAt: mid.derivationId,
      contract: C('c/B'),
      reason: 'tampered',
    });
  });

  test('determinism: same inputs → identical verdict byte-for-byte', async () => {
    await buildHappyChain();
    const registry = mkRegistry({
      'c/A': () => ({ ok: true }),
      'c/B': () => ({ ok: true }),
      'c/C': () => ({ ok: true }),
    });

    const v1 = await validateRef('current', store, registry);
    const v2 = await validateRef('current', store, registry);
    expect(JSON.stringify(v1)).toBe(JSON.stringify(v2));
  });

  test('ref not found → ref-resolution verdict', async () => {
    const registry = mkRegistry({});
    const verdict = await validateRef('missing', store, registry);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.contract).toBe(C('anchored-chain/ref-resolution'));
    expect(verdict.reason).toMatch(/not found/);
  });

  test('strict-leaf: unresolved input → missing-derivation verdict', async () => {
    const dangling = D('dangling');
    const orphan = mkDer({
      inputs: { prev: dangling },
      outputs: { out: D('orphanout') },
      contracts: ['c/X'],
    });
    await store.derivations.append(orphan);
    const registry = mkRegistry({
      'c/X': () => ({ ok: true }),
    });

    const verdict = await validateDerivation(
      orphan.derivationId,
      store.derivations,
      registry,
    );
    expect(verdict).toEqual({
      ok: false,
      failedAt: dangling,
      contract: C('anchored-chain/missing-derivation'),
      reason: 'derivation not found',
    });
  });

  test('branch DAG dedup: shared child validated exactly once', async () => {
    const leaf = mkDer({
      inputs: {},
      outputs: { out: D('leafout') },
      contracts: ['c/leaf'],
    });
    const left = mkDer({
      inputs: { shared: leaf.derivationId },
      outputs: { out: D('leftout') },
      contracts: ['c/left'],
    });
    const right = mkDer({
      inputs: { shared: leaf.derivationId },
      outputs: { out: D('rightout') },
      contracts: ['c/right'],
    });
    const top = mkDer({
      inputs: { l: left.derivationId, r: right.derivationId },
      outputs: { out: D('topout') },
      contracts: ['c/top'],
    });
    await store.derivations.append(leaf);
    await store.derivations.append(left);
    await store.derivations.append(right);
    await store.derivations.append(top);

    const calls: string[] = [];
    const registry = mkRegistry(
      {
        'c/leaf': () => ({ ok: true }),
        'c/left': () => ({ ok: true }),
        'c/right': () => ({ ok: true }),
        'c/top': () => ({ ok: true }),
      },
      { onCall: (c) => calls.push(c) },
    );

    const verdict = await validateDerivation(
      top.derivationId,
      store.derivations,
      registry,
    );
    expect(verdict).toEqual({ ok: true });
    const leafCalls = calls.filter((c) => c === 'c/leaf');
    expect(leafCalls).toHaveLength(1);
  });
});
