import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  digestManifest,
  openAnchoredChain,
  sha256Hex,
  validateRef,
  type ContractId,
  type ContractRegistry,
  type Derivation,
  type Digest,
  type Fetcher,
  type AnchoredChainStore,
  type SurfaceRef,
  type VerdictResult,
} from '@bounded-systems/anchored-chain-sqlite';

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
): ContractRegistry {
  return {
    getValidator(contractId: ContractId) {
      return (id: Digest, _bytes?: Uint8Array) => {
        const validator = map[contractId as string];
        if (!validator) {
          throw new Error(`no validator registered for ${contractId as string}`);
        }
        return validator(id);
      };
    },
  };
}

interface FakeFetcherHandle {
  readonly world: { bytes: Uint8Array };
  readonly fetcher: Fetcher;
  readonly calls: Array<{ method: 'fetch' | 'isFresh'; ref: string }>;
}

function makeWorld(initial: Uint8Array): FakeFetcherHandle {
  const world = { bytes: initial };
  const calls: Array<{ method: 'fetch' | 'isFresh'; ref: string }> = [];
  const fetcher: Fetcher = {
    async fetch(ref: SurfaceRef) {
      calls.push({ method: 'fetch', ref: ref.name });
      const bytes = world.bytes;
      const digest = sha256Hex(bytes);
      return { digest, bytes, freshnessSignal: digest };
    },
    async isFresh(ref: SurfaceRef, lastSignal: string) {
      calls.push({ method: 'isFresh', ref: ref.name });
      return sha256Hex(world.bytes) === lastSignal;
    },
  };
  return { world, fetcher, calls };
}

const REGISTRY = mkRegistry({
  'c/always-ok': () => ({ ok: true }),
  'c/always-fails': () => ({ ok: false, reason: 'refresh-shifted-contract' }),
});

interface SequenceTrace {
  readonly v1: unknown;
  readonly v2: unknown;
  readonly v3: unknown;
  readonly der1Id: Digest;
  readonly der2Id: Digest;
  readonly refLog: readonly unknown[];
}

async function runSequence(store: AnchoredChainStore): Promise<SequenceTrace> {
  const { world, fetcher } = makeWorld(new Uint8Array([1, 2, 3]));

  const o1 = await fetcher.fetch({ name: 'surface/x' });
  const der1 = mkDer({
    inputs: {},
    outputs: { surface: o1.digest },
    contracts: ['c/always-ok'],
  });
  await store.derivations.append(der1);
  await store.refs.cas({
    name: 'current',
    prevDigest: null,
    newDigest: der1.derivationId,
    reason: 'init',
    ts: 0,
  });

  const v1 = await validateRef('current', store, REGISTRY);

  world.bytes = new Uint8Array([9, 9, 9]);

  const v2 = await validateRef('current', store, REGISTRY);

  const o2 = await fetcher.fetch({ name: 'surface/x' });
  const der2 = mkDer({
    inputs: { prev: der1.derivationId },
    outputs: { surface: o2.digest },
    contracts: ['c/always-fails'],
  });
  await store.derivations.append(der2);
  await store.refs.cas({
    name: 'current',
    prevDigest: der1.derivationId,
    newDigest: der2.derivationId,
    reason: 'refresh',
    ts: 1,
  });

  const v3 = await validateRef('current', store, REGISTRY);

  return {
    v1,
    v2,
    v3,
    der1Id: der1.derivationId,
    der2Id: der2.derivationId,
    refLog: await store.refs.log('current'),
  };
}

describe('anchored-chain replay determinism (GH-1963)', () => {
  let store: AnchoredChainStore;

  beforeEach(() => {
    store = openAnchoredChain(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  test('canary — V1 == V2 across mid-flight world mutation', async () => {
    const { world, fetcher, calls } = makeWorld(new Uint8Array([1, 2, 3]));

    const o1 = await fetcher.fetch({ name: 'surface/x' });
    const der1 = mkDer({
      inputs: {},
      outputs: { surface: o1.digest },
      contracts: ['c/always-ok'],
    });
    await store.derivations.append(der1);
    await store.refs.cas({
      name: 'current',
      prevDigest: null,
      newDigest: der1.derivationId,
      reason: 'init',
      ts: 0,
    });

    const callsBefore = calls.length;
    const v1 = await validateRef('current', store, REGISTRY);

    world.bytes = new Uint8Array([9, 9, 9]);

    const v2 = await validateRef('current', store, REGISTRY);

    expect(JSON.stringify(v2)).toBe(JSON.stringify(v1));
    expect(v1).toEqual({ ok: true });
    expect(calls.length).toBe(callsBefore);
  });

  test('post-refresh verdict differs and fails on the new contract', async () => {
    const trace = await runSequence(store);

    expect(trace.v1).toEqual({ ok: true });
    expect(trace.v2).toEqual({ ok: true });
    expect(trace.v3).toEqual({
      ok: false,
      failedAt: trace.der2Id,
      contract: C('c/always-fails'),
      reason: 'refresh-shifted-contract',
    });
  });

  test('full sequence is byte-identical across two independent stores', async () => {
    const storeA = openAnchoredChain(':memory:');
    const storeB = openAnchoredChain(':memory:');
    try {
      const traceA = await runSequence(storeA);
      const traceB = await runSequence(storeB);
      expect(JSON.stringify(traceA)).toBe(JSON.stringify(traceB));
    } finally {
      storeA.close();
      storeB.close();
    }
  });

  test('validateRef does not invoke the Fetcher', async () => {
    const { fetcher, calls } = makeWorld(new Uint8Array([1, 2, 3]));

    const o1 = await fetcher.fetch({ name: 'surface/x' });
    const der1 = mkDer({
      inputs: {},
      outputs: { surface: o1.digest },
      contracts: ['c/always-ok'],
    });
    await store.derivations.append(der1);
    await store.refs.cas({
      name: 'current',
      prevDigest: null,
      newDigest: der1.derivationId,
      reason: 'init',
      ts: 0,
    });

    calls.length = 0;
    const verdict = await validateRef('current', store, REGISTRY);
    expect(verdict).toEqual({ ok: true });
    expect(calls.length).toBe(0);
  });
});
