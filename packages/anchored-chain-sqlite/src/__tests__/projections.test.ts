import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  digestManifest,
  openAnchoredChain,
  projectMany,
  projectRef,
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
const ZERO_DIGEST = `sha256:${'0'.repeat(64)}` as Digest;

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

describe('projectRef', () => {
  test('happy path: single passing derivation', async () => {
    const der = mkDer({
      inputs: {},
      outputs: { out: D('out') },
      contracts: ['c/A'],
    });
    await store.derivations.append(der);
    await store.refs.cas({
      name: 'current',
      prevDigest: null,
      newDigest: der.derivationId,
      reason: 'init',
      ts: 0,
    });
    const registry = mkRegistry({ 'c/A': () => ({ ok: true }) });

    const view = await projectRef('current')(store, registry);
    expect(view.digest).toBe(der.derivationId);
    expect(view.verdict).toEqual({ ok: true });
    expect(view.staleSince).toBeUndefined();
  });

  test('missing ref: ZERO_DIGEST with ref-resolution verdict', async () => {
    const registry = mkRegistry({});
    const view = await projectRef('absent')(store, registry);
    expect(view.digest).toBe(ZERO_DIGEST);
    expect(view.verdict.ok).toBe(false);
    if (view.verdict.ok) return;
    expect(view.verdict.contract).toBe(C('anchored-chain/ref-resolution'));
    expect(view.verdict.reason).toMatch(/not found/);
  });

  test('contract failure propagates from validateRef', async () => {
    const der = mkDer({
      inputs: {},
      outputs: { out: D('out') },
      contracts: ['c/A'],
    });
    await store.derivations.append(der);
    await store.refs.cas({
      name: 'current',
      prevDigest: null,
      newDigest: der.derivationId,
      reason: 'init',
      ts: 0,
    });
    const registry = mkRegistry({
      'c/A': () => ({ ok: false, reason: 'tampered' }),
    });

    const view = await projectRef('current')(store, registry);
    expect(view.digest).toBe(der.derivationId);
    expect(view.verdict).toEqual({
      ok: false,
      failedAt: der.derivationId,
      contract: C('c/A'),
      reason: 'tampered',
    });
  });

  test('determinism: same inputs → byte-identical projection', async () => {
    const der = mkDer({
      inputs: {},
      outputs: { out: D('out') },
      contracts: ['c/A'],
    });
    await store.derivations.append(der);
    await store.refs.cas({
      name: 'current',
      prevDigest: null,
      newDigest: der.derivationId,
      reason: 'init',
      ts: 0,
    });
    const registry = mkRegistry({ 'c/A': () => ({ ok: true }) });

    const p1 = await projectRef('current')(store, registry);
    const p2 = await projectRef('current')(store, registry);
    expect(JSON.stringify(p1)).toBe(JSON.stringify(p2));
  });

  test('freshness after ref advance: no cache-bust required', async () => {
    const der1 = mkDer({
      inputs: {},
      outputs: { out: D('out1') },
      contracts: ['c/A'],
    });
    const der2 = mkDer({
      inputs: {},
      outputs: { out: D('out2') },
      contracts: ['c/A'],
    });
    await store.derivations.append(der1);
    await store.derivations.append(der2);
    await store.refs.cas({
      name: 'current',
      prevDigest: null,
      newDigest: der1.derivationId,
      reason: 'init',
      ts: 0,
    });
    const registry = mkRegistry({ 'c/A': () => ({ ok: true }) });

    const before = await projectRef('current')(store, registry);
    expect(before.digest).toBe(der1.derivationId);

    await store.refs.cas({
      name: 'current',
      prevDigest: der1.derivationId,
      newDigest: der2.derivationId,
      reason: 'advance',
      ts: 1,
    });

    const after = await projectRef('current')(store, registry);
    expect(after.digest).toBe(der2.derivationId);
  });
});

describe('projectMany', () => {
  test('snapshot consistency: both refs in input order with verdicts', async () => {
    const aDer = mkDer({
      inputs: {},
      outputs: { out: D('aout') },
      contracts: ['c/A'],
    });
    const bDer = mkDer({
      inputs: {},
      outputs: { out: D('bout') },
      contracts: ['c/B'],
    });
    await store.derivations.append(aDer);
    await store.derivations.append(bDer);
    await store.refs.cas({
      name: 'ref/a',
      prevDigest: null,
      newDigest: aDer.derivationId,
      reason: 'init',
      ts: 0,
    });
    await store.refs.cas({
      name: 'ref/b',
      prevDigest: null,
      newDigest: bDer.derivationId,
      reason: 'init',
      ts: 0,
    });
    const registry = mkRegistry({
      'c/A': () => ({ ok: true }),
      'c/B': () => ({ ok: true }),
    });

    const result = await projectMany(['ref/a', 'ref/b'])(store, registry);
    expect(Object.keys(result)).toEqual(['ref/a', 'ref/b']);
    expect(result['ref/a']!.digest).toBe(aDer.derivationId);
    expect(result['ref/a']!.verdict).toEqual({ ok: true });
    expect(result['ref/a']!.staleSince).toBeUndefined();
    expect(result['ref/b']!.digest).toBe(bDer.derivationId);
    expect(result['ref/b']!.verdict).toEqual({ ok: true });
    expect(result['ref/b']!.staleSince).toBeUndefined();
  });

  test('staleness: ref A consumes ref B old digest → staleSince flagged on A', async () => {
    const bOld = mkDer({
      inputs: {},
      outputs: { out: D('bold-out') },
      contracts: ['c/B'],
    });
    const bNew = mkDer({
      inputs: {},
      outputs: { out: D('bnew-out') },
      contracts: ['c/B'],
    });
    const aDer = mkDer({
      inputs: { 'ref/b': bOld.derivationId },
      outputs: { out: D('aout') },
      contracts: ['c/A'],
    });
    await store.derivations.append(bOld);
    await store.derivations.append(bNew);
    await store.derivations.append(aDer);
    await store.refs.cas({
      name: 'ref/a',
      prevDigest: null,
      newDigest: aDer.derivationId,
      reason: 'init',
      ts: 0,
    });
    await store.refs.cas({
      name: 'ref/b',
      prevDigest: null,
      newDigest: bNew.derivationId,
      reason: 'init',
      ts: 0,
    });
    const registry = mkRegistry({
      'c/A': () => ({ ok: true }),
      'c/B': () => ({ ok: true }),
    });

    const result = await projectMany(['ref/a', 'ref/b'])(store, registry);
    expect(result['ref/a']!.staleSince).toBe(aDer.derivationId);
    expect(result['ref/b']!.staleSince).toBeUndefined();
  });

  test('determinism: byte-identical output across calls', async () => {
    const aDer = mkDer({
      inputs: {},
      outputs: { out: D('aout') },
      contracts: ['c/A'],
    });
    const bDer = mkDer({
      inputs: {},
      outputs: { out: D('bout') },
      contracts: ['c/B'],
    });
    await store.derivations.append(aDer);
    await store.derivations.append(bDer);
    await store.refs.cas({
      name: 'ref/a',
      prevDigest: null,
      newDigest: aDer.derivationId,
      reason: 'init',
      ts: 0,
    });
    await store.refs.cas({
      name: 'ref/b',
      prevDigest: null,
      newDigest: bDer.derivationId,
      reason: 'init',
      ts: 0,
    });
    const registry = mkRegistry({
      'c/A': () => ({ ok: true }),
      'c/B': () => ({ ok: true }),
    });

    const r1 = await projectMany(['ref/a', 'ref/b'])(store, registry);
    const r2 = await projectMany(['ref/a', 'ref/b'])(store, registry);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  test('empty input: returns empty record without throwing', async () => {
    const registry = mkRegistry({});
    const result = await projectMany([])(store, registry);
    expect(result).toEqual({});
  });

  test('mixed presence: missing ref → ZERO_DIGEST + ref-resolution verdict', async () => {
    const aDer = mkDer({
      inputs: {},
      outputs: { out: D('aout') },
      contracts: ['c/A'],
    });
    await store.derivations.append(aDer);
    await store.refs.cas({
      name: 'ref/a',
      prevDigest: null,
      newDigest: aDer.derivationId,
      reason: 'init',
      ts: 0,
    });
    const registry = mkRegistry({ 'c/A': () => ({ ok: true }) });

    const result = await projectMany(['ref/a', 'ref/missing'])(store, registry);
    expect(Object.keys(result)).toEqual(['ref/a', 'ref/missing']);
    expect(result['ref/a']!.digest).toBe(aDer.derivationId);
    expect(result['ref/a']!.verdict).toEqual({ ok: true });
    expect(result['ref/missing']!.digest).toBe(ZERO_DIGEST);
    expect(result['ref/missing']!.verdict.ok).toBe(false);
    const missingVerdict = result['ref/missing']!.verdict;
    if (missingVerdict.ok) return;
    expect(missingVerdict.contract).toBe(C('anchored-chain/ref-resolution'));
  });
});
