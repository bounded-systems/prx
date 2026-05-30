import { describe, expect, test } from 'bun:test';

import {
  canonicalJson,
  digestManifest,
} from '@bounded-systems/anchored-chain';
import type { Derivation, Digest } from '@bounded-systems/anchored-chain';

// The sha256 primitives now live in the cas substrate (src/cas/__tests__);
// these cover only the manifest-digest helpers anchored-chain owns.

describe('canonicalJson', () => {
  test('object key order is invariant', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  test('arrays preserve order', () => {
    expect(canonicalJson([1, 2, 3])).toBe('[1,2,3]');
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  test('null is preserved', () => {
    expect(canonicalJson({ a: null })).toBe('{"a":null}');
  });

  test('undefined keys are omitted', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  test('nested keys sort recursively', () => {
    expect(
      canonicalJson({ outer: { z: 1, a: 2 }, alpha: 3 }),
    ).toBe(
      canonicalJson({ alpha: 3, outer: { a: 2, z: 1 } }),
    );
  });

  test('no whitespace in output', () => {
    expect(canonicalJson({ a: { b: 1 } })).toBe('{"a":{"b":1}}');
  });
});

describe('digestManifest', () => {
  test('is invariant to key order in inputs/outputs/params', () => {
    const manifest1: Derivation['manifest'] = {
      producer: 'p',
      inputs: { a: 'sha256:1' as Digest, b: 'sha256:2' as Digest },
      outputs: { x: 'sha256:3' as Digest, y: 'sha256:4' as Digest },
      contracts: ['c/v1'],
      params: { p1: 1, p2: 2 },
    };
    const manifest2: Derivation['manifest'] = {
      producer: 'p',
      inputs: { b: 'sha256:2' as Digest, a: 'sha256:1' as Digest },
      outputs: { y: 'sha256:4' as Digest, x: 'sha256:3' as Digest },
      contracts: ['c/v1'],
      params: { p2: 2, p1: 1 },
    };
    expect(digestManifest(manifest1)).toBe(digestManifest(manifest2));
  });

  test('contracts array order matters', () => {
    const base: Derivation['manifest'] = {
      producer: 'p',
      inputs: {},
      outputs: {},
      contracts: ['a', 'b'],
      params: {},
    };
    const swapped: Derivation['manifest'] = { ...base, contracts: ['b', 'a'] };
    expect(digestManifest(base)).not.toBe(digestManifest(swapped));
  });
});
