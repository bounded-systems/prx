import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  contractHolds,
  digestManifest,
  openAnchoredChain,
  refAtDigest,
  refIsFresh,
  type ContractId,
  type ContractRegistry,
  type Derivation,
  type Digest,
  type GuardCtx,
  type GuardFn,
  type GuardResult,
  type AnchoredChainStore,
  type VerdictResult,
} from '@bounded-systems/anchored-chain-sqlite';

let store: AnchoredChainStore;
let registry: ContractRegistry;
let ctx: GuardCtx;

const D = (s: string) => `sha256:${s.padEnd(64, '0')}` as Digest;
const C = (s: string) => s as ContractId;

function mkDer(args: {
  inputs: Record<string, Digest>;
  outputs?: Record<string, Digest>;
  contracts?: readonly string[];
}): Derivation {
  const manifest = {
    producer: 'noop',
    inputs: args.inputs,
    outputs: args.outputs ?? {},
    contracts: args.contracts ?? [],
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

beforeEach(() => {
  store = openAnchoredChain(':memory:');
  registry = mkRegistry({});
  ctx = { store, registry };
});

afterEach(() => {
  store.close();
});

describe('refAtDigest', () => {
  test('happy: ref matches expected digest → ok', async () => {
    await store.refs.cas({
      name: 'foo',
      prevDigest: null,
      newDigest: D('x'),
      reason: 'init',
      ts: 1,
    });
    const verdict = await refAtDigest(ctx, 'foo', D('x'))();
    expect(verdict).toEqual({ ok: true });
  });

  test('mismatch: ref points to a different digest → fail with reason', async () => {
    await store.refs.cas({
      name: 'foo',
      prevDigest: null,
      newDigest: D('x'),
      reason: 'init',
      ts: 1,
    });
    const verdict = await refAtDigest(ctx, 'foo', D('y'))();
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toMatch(/digest mismatch/);
    expect(verdict.reason).toContain('foo');
  });

  test('missing ref → fail with not-found reason', async () => {
    const verdict = await refAtDigest(ctx, 'missing', D('x'))();
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toMatch(/ref not found/);
  });
});

describe('refIsFresh', () => {
  test('happy: cached ref newer than all input refs → fresh', async () => {
    const aDigest = D('a');
    const cached = mkDer({ inputs: { a: aDigest } });
    await store.derivations.append(cached);

    await store.refs.cas({
      name: 'a',
      prevDigest: null,
      newDigest: aDigest,
      reason: 'init',
      ts: 10,
    });
    await store.refs.cas({
      name: 'cached',
      prevDigest: null,
      newDigest: cached.derivationId,
      reason: 'init',
      ts: 20,
    });

    const verdict = await refIsFresh(ctx, 'cached')();
    expect(verdict).toEqual({ ok: true });
  });

  test('stale: input ref re-advanced after cache → fail with stale reason', async () => {
    const aDigest = D('a');
    const cached = mkDer({ inputs: { a: aDigest } });
    await store.derivations.append(cached);

    await store.refs.cas({
      name: 'a',
      prevDigest: null,
      newDigest: aDigest,
      reason: 'init',
      ts: 10,
    });
    await store.refs.cas({
      name: 'cached',
      prevDigest: null,
      newDigest: cached.derivationId,
      reason: 'init',
      ts: 20,
    });
    await store.refs.cas({
      name: 'a',
      prevDigest: aDigest,
      newDigest: D('a2'),
      reason: 'advance',
      ts: 30,
    });

    const verdict = await refIsFresh(ctx, 'cached')();
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toMatch(/stale/);
    expect(verdict.reason).toContain('a');
    expect(verdict.reason).toContain('30');
    expect(verdict.reason).toContain('20');
  });

  test('input key not tracked as a ref → skipped, returns fresh', async () => {
    const cached = mkDer({ inputs: { unknownKey: D('z') } });
    await store.derivations.append(cached);

    await store.refs.cas({
      name: 'cached',
      prevDigest: null,
      newDigest: cached.derivationId,
      reason: 'init',
      ts: 5,
    });

    const verdict = await refIsFresh(ctx, 'cached')();
    expect(verdict).toEqual({ ok: true });
  });
});

describe('contractHolds', () => {
  test('happy: validator returns ok → guard ok', async () => {
    await store.refs.cas({
      name: 'foo',
      prevDigest: null,
      newDigest: D('x'),
      reason: 'init',
      ts: 1,
    });
    const reg = mkRegistry({
      'c/foo': () => ({ ok: true }),
    });
    const localCtx: GuardCtx = { store, registry: reg };
    const verdict = await contractHolds(localCtx, 'foo', C('c/foo'))();
    expect(verdict).toEqual({ ok: true });
  });

  test('fail: validator returns ok=false → guard fail with prefixed reason', async () => {
    await store.refs.cas({
      name: 'foo',
      prevDigest: null,
      newDigest: D('x'),
      reason: 'init',
      ts: 1,
    });
    const reg = mkRegistry({
      'c/foo': () => ({ ok: false, reason: 'bad' }),
    });
    const localCtx: GuardCtx = { store, registry: reg };
    const verdict = await contractHolds(localCtx, 'foo', C('c/foo'))();
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain('c/foo');
    expect(verdict.reason).toContain('bad');
  });
});

describe('spike invariant #2 — store is authoritative', () => {
  // The guard signature `() => Promise<GuardResult>` has no input channel
  // for caller-supplied state. The only way a guard can observe the world
  // is via the (store, registry) ctx closed over at factory time, so a
  // caller cannot manufacture authority by lying in an event payload.
  test('GuardFn signature has no event/payload parameter (type-level proof)', async () => {
    await store.refs.cas({
      name: 'foo',
      prevDigest: null,
      newDigest: D('actual'),
      reason: 'init',
      ts: 1,
    });

    // This assignment compiles iff GuardFn is exactly `() => Promise<GuardResult>`.
    const proof: GuardFn = refAtDigest(ctx, 'foo', D('expected'));
    expect(typeof proof).toBe('function');
    expect(proof.length).toBe(0);
  });

  test('guard returns store-truth verdict; caller has no channel to override', async () => {
    await store.refs.cas({
      name: 'foo',
      prevDigest: null,
      newDigest: D('actual'),
      reason: 'init',
      ts: 1,
    });

    const guard = refAtDigest(ctx, 'foo', D('expected'));
    const verdict: GuardResult = await guard();
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toMatch(/digest mismatch/);

    // A second invocation cannot supply a payload — the signature forbids it.
    // The verdict is whatever the store says, by construction.
    const verdict2 = await guard();
    expect(verdict2).toEqual(verdict);
  });
});
