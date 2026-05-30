import { isStale as lineageIsStale, type LineageCapable } from './lineage.ts';
import {
  validateRef,
  type ValidationCapable,
  type Verdict,
} from './validate.ts';
import type { ContractRegistry } from './interfaces.ts';
import type { Digest } from './types.ts';

export interface ProjectionCapable extends ValidationCapable, LineageCapable {}

export type Projection<T> = (
  store: ProjectionCapable,
  registry: ContractRegistry,
) => Promise<T>;

export interface RefProjectionView {
  readonly digest: Digest;
  readonly verdict: Verdict;
  readonly staleSince?: Digest;
}

const ZERO_DIGEST = `sha256:${'0'.repeat(64)}` as Digest;

export function projectRef(refName: string): Projection<RefProjectionView> {
  return async (store, registry) => {
    const ref = await store.refs.get(refName);
    const verdict = await validateRef(refName, store, registry);
    const digest = ref?.digest ?? ZERO_DIGEST;
    return { digest, verdict };
  };
}

export function projectMany(
  refNames: readonly string[],
): Projection<Readonly<Record<string, RefProjectionView>>> {
  return async (store, registry) => {
    const snapshot: Record<string, Digest> = {};
    const resolved: Record<string, Digest | null> = {};
    for (const name of refNames) {
      const r = await store.refs.get(name);
      if (r === null) {
        resolved[name] = null;
      } else {
        snapshot[name] = r.digest;
        resolved[name] = r.digest;
      }
    }

    const out: Record<string, RefProjectionView> = {};
    for (const name of refNames) {
      const verdict = await validateRef(name, store, registry);
      const resolvedDigest = resolved[name] ?? null;
      const digest = resolvedDigest ?? ZERO_DIGEST;
      if (resolvedDigest !== null) {
        const stale = await lineageIsStale(store, resolvedDigest, snapshot);
        if (stale) {
          out[name] = { digest, verdict, staleSince: resolvedDigest };
        } else {
          out[name] = { digest, verdict };
        }
      } else {
        out[name] = { digest, verdict };
      }
    }
    return out;
  };
}
