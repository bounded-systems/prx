// GH-1595 — per-invocation memoization layer over `loadAllBeads`. One cache
// is constructed at the CLI entry (`runCli`) and threaded via existing DI
// (`loadAllBeads?` / `execBd?`) into every verb that already accepts those
// deps. Writers (`bd update --external-ref`, `bd update <axes>`) call
// `invalidate()` before the next read; the loader re-fetches on the next
// `load()`.
//
// Why at this layer (not `execBd`): invalidation policy needs to distinguish
// `bd update` (mutates the canonical `list` projection) from `bd show` (no
// mutation), which `execBd` cannot see. Sitting above `loadAllBeads` keeps
// the typed `BeadsRecord` shape and puts `invalidate()` next to the writers
// that know they wrote.
//
// Scope: a `BeadsCache` is per-CLI-process. Cross-process loops like
// `for n in …; do prx beads issue GH-$n; done` are O(N) Bun starts — a
// per-process cache cannot help that case (GH-1554 is the relevant streaming
// boundary fix; this is the parallel in-process win).

import {
  execBd as defaultExecBd,
  type BdExecResult,
} from "@bounded-systems/bd";
import { loadAllBeads as defaultLoadAllBeads, type BeadsRecord } from "./triage.ts";

export type BeadsCache = {
  /** First call runs `loadAllBeads(exec)`; subsequent calls return the cached array until `invalidate()`. */
  load(): BeadsRecord[];
  /** Drop the cached array. Next `load()` re-reads via `loadAllBeads(exec)`. */
  invalidate(): void;
};

export type CreateBeadsCacheOptions = {
  exec?: (...args: Parameters<typeof defaultExecBd>) => BdExecResult;
  loadAllBeads?: typeof defaultLoadAllBeads;
};

export function createBeadsCache(options: CreateBeadsCacheOptions = {}): BeadsCache {
  const exec = options.exec ?? defaultExecBd;
  const loader = options.loadAllBeads ?? defaultLoadAllBeads;
  let cached: BeadsRecord[] | null = null;
  return {
    load(): BeadsRecord[] {
      if (cached === null) {
        cached = loader(exec);
      }
      return cached;
    },
    invalidate(): void {
      cached = null;
    },
  };
}
