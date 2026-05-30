import { sha256Hex } from '@bounded-systems/cas';
import type { Digest } from '@bounded-systems/cas';

import type { Derivation } from './types.ts';

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function digestManifest(manifest: Derivation['manifest']): Digest {
  return sha256Hex(canonicalJson(manifest));
}

function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = canonicalize(v);
    return out;
  }
  return value;
}
