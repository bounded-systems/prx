// GH-1662 — cross-repo reconcile cursor.
//
// Persistent pause-and-resume state for the cross-repo daemon
// (`prx beads sync --all-repos`). When a tick's shared GitHub-API budget
// drains mid-way through the indexed-repo walk, the orchestrator pins
// `nextRepoSlug` to the repo it was processing (mid-repo pause) or the
// repo it was about to process (between-repo pause). The next tick reads
// the cursor and resumes there, rotating fairly through the index instead
// of starving repos at the back.
//
// Persistence: `$XDG_STATE_HOME/prx/sync/cross-repo-cursor.json`,
// `$XDG_STATE_HOME` defaulting to `~/.local/state` (mirrors the path
// resolution in `src/audit/sink.ts`).
//
// Invariants (informal; the orchestrator promotes these to `invariantSpecs`):
//   - I-DS3 cursor monotonicity. Within an in-progress tick the cursor only
//     advances; on full drain the file is deleted and the next tick starts
//     at the top with a fresh `tickStartedAt`.
//   - I-F4 family — write atomicity. tmp + rename so a partial cursor file
//     can never appear on disk (e.g. SIGINT mid-write).

import { processEnv } from "@bounded-systems/env";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homeDir } from "@bounded-systems/host";
import { dirname, join } from "node:path";

export type CrossRepoCursor = {
  /** ISO-8601 timestamp marking when this in-progress walk began. */
  tickStartedAt: string;
  /** Inventory slug to resume at. */
  nextRepoSlug: string;
};

export type CrossRepoCursorOptions = {
  /** Override the resolved sink path. */
  path?: string;
  /** Override `processEnv()`. */
  env?: NodeJS.ProcessEnv;
};

function resolveStateDir(env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_STATE_HOME?.trim();
  if (xdg && xdg.length > 0) return xdg;
  return join(homeDir(), ".local", "state");
}

export function crossRepoCursorPath(opts: CrossRepoCursorOptions = {}): string {
  if (opts.path) return opts.path;
  const env = opts.env ?? processEnv();
  return join(resolveStateDir(env), "prx", "sync", "cross-repo-cursor.json");
}

export function readCrossRepoCursor(opts: CrossRepoCursorOptions = {}): CrossRepoCursor | null {
  const path = crossRepoCursorPath(opts);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as Record<string, unknown>).tickStartedAt !== "string" ||
    typeof (parsed as Record<string, unknown>).nextRepoSlug !== "string"
  ) {
    return null;
  }
  const obj = parsed as Record<string, string>;
  // Both keys validated as strings by the typeof guards above.
  return { tickStartedAt: obj.tickStartedAt!, nextRepoSlug: obj.nextRepoSlug! };
}

export function writeCrossRepoCursor(
  cursor: CrossRepoCursor,
  opts: CrossRepoCursorOptions = {},
): void {
  const path = crossRepoCursorPath(opts);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cursor, null, 2)}\n`);
  renameSync(tmp, path);
}

export function clearCrossRepoCursor(opts: CrossRepoCursorOptions = {}): void {
  const path = crossRepoCursorPath(opts);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}
