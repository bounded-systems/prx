// `prx dep status` inspector (GH-1275, PR-3 of GH-1261).
//
// Read-only. Walks `<repoRoot>/.prx/dep-research/<dep>/`, parses the latest
// two snapshots through the boundary schema, and recomputes classification
// via `diffSnapshots`. Recomputed every call — zero cache, zero drift surface.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { diffSnapshots } from "./diff.ts";
import { loadDepManifest } from "./manifest.ts";
import {
  DepSnapshot,
  type DepClassification,
  type DepManifestEntry,
} from "./schemas.ts";

export type DepStatusRunState = "ok" | "failed" | "never";

export type DepStatusRow = {
  dep: string;
  last_run_id: string | null;
  prev_run_id: string | null;
  fetched_at: string | null;
  run_state: DepStatusRunState;
  classification: DepClassification | null;
};

const SNAPSHOT_DIR_RELATIVE = ".prx/dep-research";

/**
 * Compute one status row per manifest entry. Rows are returned in manifest
 * order so the operator's view is stable across calls.
 */
export function loadDepStatus(repoRoot: string): DepStatusRow[] {
  const entries = loadDepManifest(repoRoot);
  const baseDir = join(repoRoot, SNAPSHOT_DIR_RELATIVE);
  return entries.map((entry) => statusForEntry(entry, baseDir));
}

function statusForEntry(
  entry: DepManifestEntry,
  baseDir: string,
): DepStatusRow {
  const depDir = join(baseDir, entry.name);
  const runIds = listRunIds(depDir);
  if (runIds.length === 0) {
    return {
      dep: entry.name,
      last_run_id: null,
      prev_run_id: null,
      fetched_at: null,
      run_state: "never",
      classification: null,
    };
  }

  const lastRunId = runIds.at(-1)!;
  const prevRunId = runIds.length >= 2 ? runIds.at(-2)! : null;

  const last = readSnapshot(depDir, lastRunId);
  const prev = prevRunId !== null ? readSnapshot(depDir, prevRunId) : null;

  if (!last) {
    return {
      dep: entry.name,
      last_run_id: lastRunId,
      prev_run_id: prevRunId,
      fetched_at: null,
      run_state: "failed",
      classification: null,
    };
  }

  const delta = diffSnapshots(prev, last, entry.classification_hints);
  return {
    dep: entry.name,
    last_run_id: last.run_id,
    prev_run_id: prev?.run_id ?? null,
    fetched_at: last.fetched_at,
    run_state: last.run_state,
    classification: delta.classification,
  };
}

function listRunIds(depDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(depDir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => !name.startsWith("."))
    .filter((name) => {
      try {
        return statSync(join(depDir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

function readSnapshot(depDir: string, runId: string): DepSnapshot | null {
  const path = join(depDir, runId, "snapshot.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return DepSnapshot.parse(parsed);
  } catch {
    return null;
  }
}

export function formatDepStatusPlain(rows: DepStatusRow[]): string {
  if (rows.length === 0) return "(no deps in manifest)";
  const lines: string[] = [];
  for (const row of rows) {
    const last = row.last_run_id ?? "—";
    const state = row.run_state;
    const cls = row.classification ?? "—";
    const prev = row.prev_run_id ? ` (prev: ${row.prev_run_id})` : "";
    lines.push(`${row.dep.padEnd(10)} ${last.padEnd(18)} ${state.padEnd(8)} ${cls}${prev}`);
  }
  return lines.join("\n");
}

export function formatDepStatusJson(rows: DepStatusRow[]): string {
  return JSON.stringify(rows, null, 2);
}
