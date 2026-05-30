import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  invalidateDescendants,
  openAnchoredChain,
  type Derivation,
  type Digest,
  type AnchoredChainStore,
} from '@bounded-systems/anchored-chain-sqlite';

let store: AnchoredChainStore;

beforeEach(() => {
  store = openAnchoredChain(':memory:');
});

afterEach(() => {
  store.close();
});

const D = (s: string) => `sha256:${s.padEnd(64, '0')}` as Digest;

function mkDer(args: {
  id: string;
  inputs: Record<string, Digest>;
  outputs: Record<string, Digest>;
}): Derivation {
  return {
    derivationId: D(args.id),
    manifest: {
      producer: 'noop',
      inputs: args.inputs,
      outputs: args.outputs,
      contracts: [],
      params: {},
    },
    ts: 0,
  };
}

describe('invalidate.descendants', () => {
  test('walks transitive chain A → B → C plus branch A → D', async () => {
    const A = D('a');
    const aOut = D('aout');
    const bOut = D('bout');
    const cOut = D('cout');
    const dOut = D('dout');

    // A consumes input "src"=A → produces aOut
    await store.derivations.append(
      mkDer({ id: 'A', inputs: { src: A }, outputs: { out: aOut } }),
    );
    // B consumes A's output → produces bOut
    await store.derivations.append(
      mkDer({ id: 'B', inputs: { src: aOut }, outputs: { out: bOut } }),
    );
    // C consumes B's output → produces cOut
    await store.derivations.append(
      mkDer({ id: 'C', inputs: { src: bOut }, outputs: { out: cOut } }),
    );
    // D consumes A's output → produces dOut (branch)
    await store.derivations.append(
      mkDer({ id: 'D', inputs: { src: aOut }, outputs: { out: dOut } }),
    );

    const stale = await invalidateDescendants(store, A);
    expect(stale.sort()).toEqual([D('A'), D('B'), D('C'), D('D')].sort());
  });

  test('moving an unrelated digest returns no descendants', async () => {
    const A = D('a');
    const aOut = D('aout');
    const bOut = D('bout');
    await store.derivations.append(
      mkDer({ id: 'A', inputs: { src: A }, outputs: { out: aOut } }),
    );
    await store.derivations.append(
      mkDer({ id: 'B', inputs: { src: aOut }, outputs: { out: bOut } }),
    );

    const stale = await invalidateDescendants(store, D('unrelated'));
    expect(stale).toEqual([]);
  });
});
