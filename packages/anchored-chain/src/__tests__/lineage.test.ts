import { describe, expect, test } from 'bun:test';

import {
  ancestors,
  isStale,
  lineageDescendants,
} from '@bounded-systems/anchored-chain';
import type { Digest, LineageCapable } from '@bounded-systems/anchored-chain';

// The lineage helpers are thin facade functions that forward to the store's
// `lineage` port. These cover that the (store, args) → store.lineage.*(args)
// delegation passes arguments through and returns the port's result verbatim.

const d = (s: string) => s as Digest;

/**
 * A spy store recording the last call to each lineage method and returning
 * canned values, so we can assert both the forwarding and the return value.
 */
function spyStore(): LineageCapable & {
  calls: { method: string; args: unknown[] }[];
} {
  const calls: { method: string; args: unknown[] }[] = [];
  return {
    calls,
    lineage: {
      ancestors(derivationId) {
        calls.push({ method: 'ancestors', args: [derivationId] });
        return Promise.resolve([d('anc-1'), d('anc-2')]);
      },
      descendants(derivationId) {
        calls.push({ method: 'descendants', args: [derivationId] });
        return Promise.resolve([d('desc-1')]);
      },
      isStale(derivationId, currentRefs) {
        calls.push({ method: 'isStale', args: [derivationId, currentRefs] });
        return Promise.resolve(true);
      },
    },
  };
}

describe('lineage facade', () => {
  test('ancestors forwards the derivationId and returns the port result', async () => {
    const store = spyStore();
    const result = await ancestors(store, d('node-a'));
    expect(result).toEqual([d('anc-1'), d('anc-2')]);
    expect(store.calls).toEqual([{ method: 'ancestors', args: [d('node-a')] }]);
  });

  test('descendants forwards the derivationId and returns the port result', async () => {
    const store = spyStore();
    const result = await lineageDescendants(store, d('node-b'));
    expect(result).toEqual([d('desc-1')]);
    expect(store.calls).toEqual([
      { method: 'descendants', args: [d('node-b')] },
    ]);
  });

  test('isStale forwards derivationId + currentRefs and returns the verdict', async () => {
    const store = spyStore();
    const refs = { 'src@pinned': d('ref-1') };
    const result = await isStale(store, d('node-c'), refs);
    expect(result).toBe(true);
    expect(store.calls).toEqual([
      { method: 'isStale', args: [d('node-c'), refs] },
    ]);
  });
});
