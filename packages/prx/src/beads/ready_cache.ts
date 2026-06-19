// GH-1510 — sync-if-stale cache layer for bd-ready queries.
//
// Invariants (mirror src/machine/state.ts `invariantSpecs`):
//   - I-BD2: cache writes are atomic (tmp + rename); no partial file ever
//            appears on disk.
//   - I-BD3: cache reads served past TTL emit BD_READY_CACHE_STALE_SERVED so
//            the operator can see staleness. (The event-emission point is in
//            the picker — this module returns `stale` on the read result and
//            the picker maps it to the audit-log event.)
//
// On-disk path: `<repo>/.beads/cache/ready.json`. The whole `.beads/cache/`
// subdir is gitignored (added in this PR if not already).
//
// Refresh policy:
//   - `getBdReady({ force: true })`              → always re-query bd.
//   - cache missing / invalid / older than TTL   → re-query bd, write cache.
//   - otherwise                                  → return cached envelope.
//
// TTL default: 60s. Configurable via `prx.toml [beads] ready_ttl_seconds`.
// The picker is the canonical caller; ad-hoc callers should generally let
// the picker manage the cache.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { BdReadyCacheSchema, queryBdReady, type BdReadyCache, type BdRunner } from "./ready.ts";

export const DEFAULT_READY_TTL_SECONDS = 60;

export type GetBdReadyOptions = {
  /** Override TTL for this call (otherwise from prx.toml or default). */
  ttlSeconds?: number | undefined;
  /** Skip the cache; always re-query bd and overwrite the cache file. */
  force?: boolean | undefined;
  /** Inject a bd runner for tests. */
  runner?: BdRunner | undefined;
};

export type GetBdReadyResult = {
  cache: BdReadyCache;
  /** True iff the on-disk cache was older than TTL when read.  */
  stale: boolean;
  /** True iff this call refreshed (live bd query + cache write). */
  refreshed: boolean;
};

function cacheDir(repoPath: string): string {
  return join(repoPath, ".beads", "cache");
}

export function cacheFilePath(repoPath: string): string {
  return join(cacheDir(repoPath), "ready.json");
}

export function readCache(repoPath: string): BdReadyCache | null {
  const path = cacheFilePath(repoPath);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    const result = BdReadyCacheSchema.safeParse(parsed);
    if (!result.success) return null;
    return result.data;
  } catch {
    return null;
  }
}

/**
 * Write the cache atomically: write to a temp sibling, then `renameSync` over
 * the target. POSIX rename is atomic within a filesystem, so a crash mid-call
 * leaves either the previous file or the new file — never a partial. (I-BD2.)
 */
export function writeCache(repoPath: string, cache: BdReadyCache): void {
  const dir = cacheDir(repoPath);
  mkdirSync(dir, { recursive: true });
  const target = cacheFilePath(repoPath);
  const tmp = join(dir, `.ready.json.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  // Validate before serializing — surfacing a schema bug at write time is
  // strictly better than producing an unparseable cache file.
  const validated = BdReadyCacheSchema.parse(cache);
  writeFileSync(tmp, JSON.stringify(validated, null, 2), "utf8");
  renameSync(tmp, target);
}

function isStale(cache: BdReadyCache, nowMs: number): boolean {
  const queriedMs = Date.parse(cache.queried_at);
  if (Number.isNaN(queriedMs)) return true;
  const age = (nowMs - queriedMs) / 1000;
  return age > cache.ttl_seconds;
}

function newRunId(): string {
  return `bd-ready-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

/**
 * Sync-if-stale orchestration. Reads the on-disk cache; if absent or older
 * than TTL (or `force=true`), runs a live `bd ready --explain --json` and
 * rewrites the cache. Always returns a populated `BdReadyCache` plus
 * `stale`/`refreshed` flags so the picker can emit the right audit events
 * (BD_READY_CACHE_HIT vs *_STALE_SERVED vs *_REFRESHED).
 */
export function getBdReady(repoPath: string, opts: GetBdReadyOptions = {}): GetBdReadyResult {
  const ttlSeconds = opts.ttlSeconds ?? DEFAULT_READY_TTL_SECONDS;
  const now = Date.now();

  const existing = readCache(repoPath);

  if (!opts.force && existing) {
    const stale = isStale(existing, now);
    if (!stale) {
      return { cache: existing, stale: false, refreshed: false };
    }
    // Stale: refresh below. The fact that we *had* a stale cache is preserved
    // so the picker can emit BD_READY_CACHE_STALE_SERVED before the refresh
    // completes, then BD_READY_CACHE_REFRESHED after.
  }

  // Live query (force, missing, invalid, or stale).
  const live = queryBdReady({ cwd: repoPath, runner: opts.runner });
  const cache: BdReadyCache = {
    run_id: newRunId(),
    queried_at: new Date(now).toISOString(),
    ttl_seconds: ttlSeconds,
    ready: live.ready,
    blocked: live.blocked,
    edges: [],
  };
  writeCache(repoPath, cache);
  return { cache, stale: existing != null && isStale(existing, now), refreshed: true };
}

// -----------------------------------------------------------------------
// prx.toml loader for [beads] ready_ttl_seconds
// -----------------------------------------------------------------------

/**
 * Read `[beads] ready_ttl_seconds` from `<repoPath>/prx.toml`. Returns
 * `DEFAULT_READY_TTL_SECONDS` if the file is missing, the section is absent,
 * or the value isn't a positive integer.
 *
 * Implementation matches the line-by-line TOML reader pattern used by
 * `loadSurfaceSyncConfig` in `src/pr-state/github.ts` — small enough that
 * pulling a TOML parser dep isn't worth it.
 */
export function loadReadyTtlSeconds(repoPath: string): number {
  const configPath = join(repoPath, "prx.toml");
  if (!existsSync(configPath)) return DEFAULT_READY_TTL_SECONDS;

  let section = "";
  for (const rawLine of readFileSync(configPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const sectionMatch = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1] ?? "";
      continue;
    }
    if (section !== "beads") continue;
    const keyMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!keyMatch || keyMatch[1] !== "ready_ttl_seconds") continue;
    const raw = (keyMatch[2] ?? "").trim();
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }

  return DEFAULT_READY_TTL_SECONDS;
}
