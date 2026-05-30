// GH-867 — unified on-disk Notion task cache.
//
// Both Notion resolvers (`NotionCliResolver`, `NotionClaudeMcpResolver`)
// previously wrote per-resolver suffixed files into
// `<repoRoot>/.prx/notion-cache/`:
//
//   - notion-cli:        <task>.notion-cli.json   { pageId, title, url }
//   - notion-claude-mcp: <task>.lookup.json       { pageId, pageUrl }
//                        <task>.fetch.json        { title, body, state, url }
//
// This module collapses those three files into a single `<task>.json` keyed by
// canonical task id. The on-disk shape is `NotionTaskCacheSchema`:
//
//   { schemaVersion: 1, lookup?: NotionLookup, fetch?: NotionFetch }
//
// `mergeLookup` / `mergeFetch` preserve the other half so the cli resolver's
// lookup is not erased when the mcp resolver writes a fetch (or vice versa).
// Writes are atomic (tmp + rename) so a crash mid-write leaves the prior file
// intact.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

import { z } from "zod";

// GH-867: `title` and `url` are nullable strings — both resolvers can lookup
// without one or both. `pageId` is the only required field; without it the
// lookup is useless.
export const NotionLookupSchema = z.object({
  pageId: z.string().min(1),
  title: z.string().nullable(),
  url: z.string().nullable(),
});
export type NotionLookup = z.infer<typeof NotionLookupSchema>;

// GH-867: shape mirrors `ResolvedWorkUnit` minus `id`/`source` — those come
// from the resolver, not the cache. `fetchedAt` is ISO 8601 so a future TTL
// can be added without re-deriving timestamps from file mtime.
export const NotionFetchSchema = z.object({
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(["open", "closed", "unknown"]),
  url: z.string().nullable(),
  fetchedAt: z.string(),
});
export type NotionFetch = z.infer<typeof NotionFetchSchema>;

export const NotionTaskCacheSchema = z.object({
  schemaVersion: z.literal(1),
  lookup: NotionLookupSchema.optional(),
  fetch: NotionFetchSchema.optional(),
});
export type NotionTaskCache = z.infer<typeof NotionTaskCacheSchema>;

const SCHEMA_VERSION = 1 as const;

/**
 * Read a unified task cache file. Returns `null` on missing file, parse
 * error, or schema mismatch — callers treat each as a cache miss.
 */
export function readTaskCache(file: string): NotionTaskCache | null {
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const parsed = NotionTaskCacheSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function atomicWrite(file: string, value: NotionTaskCache): void {
  mkdirSync(dirname(file), { recursive: true });
  // GH-867: tmp-then-rename keeps the prior file intact if `writeFileSync`
  // throws partway through (disk full / sigterm). The randomness suffix
  // avoids a clash if two resolvers race.
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

/**
 * Merge a new lookup half into the cache file, preserving the existing fetch
 * half. Creates the file if missing.
 */
export function mergeLookup(file: string, lookup: NotionLookup): void {
  const existing = readTaskCache(file);
  const next: NotionTaskCache = {
    schemaVersion: SCHEMA_VERSION,
    lookup,
    ...(existing?.fetch ? { fetch: existing.fetch } : {}),
  };
  atomicWrite(file, next);
}

/**
 * Merge a new fetch half into the cache file, preserving the existing lookup
 * half. Creates the file if missing.
 */
export function mergeFetch(file: string, fetch: NotionFetch): void {
  const existing = readTaskCache(file);
  const next: NotionTaskCache = {
    schemaVersion: SCHEMA_VERSION,
    ...(existing?.lookup ? { lookup: existing.lookup } : {}),
    fetch,
  };
  atomicWrite(file, next);
}

/**
 * Clear only the fetch half of the cache, preserving the lookup. Used by
 * `NotionClaudeMcpResolver.invalidateFetch` so the cli resolver's lookup
 * survives an mcp-side fetch invalidation.
 */
export function invalidateFetchField(file: string): void {
  const existing = readTaskCache(file);
  if (!existing) return;
  if (!existing.lookup) {
    // No lookup half to preserve — remove the whole file.
    try {
      unlinkSync(file);
    } catch {
      // ignore
    }
    return;
  }
  const next: NotionTaskCache = {
    schemaVersion: SCHEMA_VERSION,
    lookup: existing.lookup,
  };
  atomicWrite(file, next);
}

/**
 * Remove the entire task-cache file. Used by `NotionCliResolver.invalidate`
 * which has no fetch half to preserve.
 */
export function invalidateEntireTask(file: string): void {
  if (existsSync(file)) {
    try {
      unlinkSync(file);
    } catch {
      // ignore
    }
  }
}
