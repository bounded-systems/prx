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
import { loadAllBeadsViaCli } from "./beads-daemon-loader.ts";

export type BeadsCache = {
  /**
   * Return the cached array, re-loading via `loadAllBeads(exec)` when there is no
   * cache. With a `generation` source (GH-296), a load also re-fetches when the
   * dataset etag (dolt HEAD) has moved since the cached copy — so a stable HEAD
   * serves cached data even after writes elsewhere.
   */
  load(): BeadsRecord[];
  /** Drop the cached array. Next `load()` re-reads via `loadAllBeads(exec)`. */
  invalidate(): void;
  /**
   * GH-296: UoW-coherent write-through. After a write, splice the mutated record
   * into the cache by id (replace-or-insert) instead of busting the whole array —
   * so one changed UoW doesn't force a full re-list. No-op when nothing is cached.
   */
  upsert(record: BeadsRecord): void;
  /** GH-296: drop one record by id from the cache (e.g. a delete). No-op when uncached. */
  remove(id: string): void;
};

export type CreateBeadsCacheOptions = {
  exec?: (...args: Parameters<typeof defaultExecBd>) => BdExecResult;
  /**
   * Aggregate bead loader. When omitted, the cache reads through the daemon
   * (GH-296 / prx-fda — a sync `prx beads list --all` spawn), NOT the host `bd`.
   * Inject a `() => BeadsRecord[]` in tests, or a local-`bd` loader to opt back
   * out. When injected, `exec` is forwarded to it (legacy `loadAllBeads(exec)`).
   */
  loadAllBeads?: typeof defaultLoadAllBeads;
  /**
   * GH-296: the dataset generation (the daemon's dolt HEAD etag). When provided,
   * `load()` re-fetches only when the generation changed since the cached copy —
   * an unchanged HEAD avoids re-listing. Omit for the legacy memoize-once cache.
   */
  generation?: (() => string | undefined) | undefined;
};

export function createBeadsCache(options: CreateBeadsCacheOptions = {}): BeadsCache {
  const exec = options.exec ?? defaultExecBd;
  // GH-296 / prx-fda: default to the daemon (one true source) rather than the
  // host `bd` against a per-clone .beads. An injected loader (tests, or an
  // explicit local-bd loader) wins and receives `exec` for the legacy signature.
  const injectedLoader = options.loadAllBeads;
  const load = injectedLoader ? () => injectedLoader(exec) : () => loadAllBeadsViaCli();
  const generation = options.generation;
  let cached: BeadsRecord[] | null = null;
  let cachedGen: string | undefined;
  return {
    load(): BeadsRecord[] {
      const gen = generation?.();
      // Re-fetch when uncached, or when the dataset generation moved.
      if (cached === null || (generation !== undefined && gen !== cachedGen)) {
        cached = load();
        cachedGen = gen;
      }
      return cached;
    },
    invalidate(): void {
      cached = null;
      cachedGen = undefined;
    },
    upsert(record: BeadsRecord): void {
      if (cached === null) return;
      const i = cached.findIndex((r) => r.id === record.id);
      if (i >= 0) cached[i] = record;
      else cached.push(record);
    },
    remove(id: string): void {
      if (cached === null) return;
      cached = cached.filter((r) => r.id !== id);
    },
  };
}
