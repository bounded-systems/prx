// The gh-issues fetch cursor (GH-1245; prx-82b 2e.2).
//
// WHAT IT IS: a LOCAL-FIRST, self-healing optimization cursor — the `updatedAt`
// of the last gh issue mirrored into beads, so the next fetch only pulls issues
// changed since (instead of re-reading everything). Like git-ai's local tracking
// (and the sync agent's `sync/push-watermark.ts`), it is HOST-LOCAL state under
// `~/.local/state/prx/sync/`, NOT data that must travel: the canonical issue data
// lives in beads (which travels/survives via dolt). A missing cursor (fresh host,
// new repo, lost file) is never WRONG — it just triggers one full re-fetch, then
// re-establishes itself. That self-healing is how the durability concern is met
// without depending on host `bd` (the old `bd config` home, prx-82b) — a fetch
// cursor on the hot, sync, no-subprocess `work --check`/freshness path can't go
// through host bd or the beadsd door (a subprocess), so it's a plain local file.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { getEnv } from "@bounded-systems/env";

/** Logical cursor names (also the on-disk basenames). Kept stable for logs. */
export const WATERMARK_KEY = "prx.fetch.gh-issues.watermark";
export const LAST_POINTS_KEY = "prx.fetch.gh-issues.last-points";

export class WatermarkError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "WatermarkError";
    this.code = code;
  }
}

export type WatermarkDeps = {
  /** The repo working dir the cursor is keyed by. */
  cwd: string;
  /** Read a file (default `fs.readFileSync`); tests inject. */
  readFile?: ((path: string) => string) | undefined;
  /** Write a file, creating parent dirs (default `fs`); tests inject. */
  writeFile?: ((path: string, data: string) => void) | undefined;
  /** Env lookup (default {@link getEnv}) — for `$HOME`. */
  env?: typeof getEnv | undefined;
};

/** Filesystem-safe key from the repo cwd. */
function safeKey(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * The host-local cursor dir for a repo cwd. `null` when `$HOME` is unset (no
 * persistence — every fetch is a full fetch, still correct).
 */
function cursorDir(cwd: string, env: typeof getEnv): string | null {
  const home = env("HOME");
  if (typeof home !== "string" || home.length === 0) return null;
  return `${home}/.local/state/prx/sync/gh-issues/${safeKey(cwd)}`;
}

/** Read a cursor file; `null` when absent/empty/unreadable (⇒ full fetch). */
function readCursor(deps: WatermarkDeps, name: string): string | null {
  const env = deps.env ?? getEnv;
  const dir = cursorDir(deps.cwd, env);
  if (dir === null) return null;
  const read = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  try {
    const value = read(`${dir}/${name}`).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null; // absent ⇒ null ⇒ full re-fetch (self-healing)
  }
}

/** Write a cursor file (best-effort — a failed write just means re-fetch next tick). */
function writeCursor(deps: WatermarkDeps, name: string, value: string): void {
  const env = deps.env ?? getEnv;
  const dir = cursorDir(deps.cwd, env);
  if (dir === null) return; // no HOME ⇒ no persistence
  const write =
    deps.writeFile ??
    ((p: string, data: string) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(p, data);
    });
  try {
    write(`${dir}/${name}`, value);
  } catch {
    // Best-effort: the cursor is an optimization; a lost write self-heals on the
    // next fetch (re-reads from the last persisted cursor, or full if none).
  }
}

/** The fetch watermark (last mirrored `updatedAt`), or `{ since: null }` if unset. */
export function getWatermark(deps: WatermarkDeps): { since: string | null } {
  return { since: readCursor(deps, "watermark") };
}

/** The last-points cursor (GH points budget), or `{ points: null }` if unset/invalid. */
export function getLastPoints(deps: WatermarkDeps): { points: number | null } {
  const raw = readCursor(deps, "last-points");
  if (raw === null) return { points: null };
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? { points: n } : { points: null };
}

/** Advance the fetch watermark. Best-effort (a lost write self-heals). */
export function setWatermark(deps: WatermarkDeps, since: string): void {
  writeCursor(deps, "watermark", since);
}
