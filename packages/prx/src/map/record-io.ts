// Map-record on-disk I/O (GH-2016 PR-1).
//
// Files live at `<repoRoot>/.prx/maps/<name>.json`. Reads parse through the
// `MapRecord` schema at the boundary; writes go via a sibling tmp file +
// `renameSync` so a half-written `<name>.json` never appears (mirrors the
// atomic-write pattern in src/dep-research/snapshot.ts:65).

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { MapRecord } from "./schemas/index.ts";

export const MAPS_SUBDIR = join(".prx", "maps");

export function mapsDir(repoRoot: string): string {
  return join(repoRoot, MAPS_SUBDIR);
}

export function mapFilePath(repoRoot: string, name: string): string {
  return join(mapsDir(repoRoot), `${name}.json`);
}

/**
 * Atomically write a {@link MapRecord} to `<repoRoot>/.prx/maps/<name>.json`.
 * The schema is re-validated before serialization so a malformed record never
 * makes it to disk. Returns the absolute path written.
 */
export function writeMapRecord(repoRoot: string, record: MapRecord): string {
  const validated = MapRecord.parse(record);
  const dir = mapsDir(repoRoot);
  mkdirSync(dir, { recursive: true });

  const finalPath = mapFilePath(repoRoot, validated.name);
  const tmpPath = join(dir, `.tmp.${validated.name}.${process.pid}.json`);

  try {
    writeFileSync(tmpPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
    renameSync(tmpPath, finalPath);
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // best-effort cleanup
    }
    throw err;
  }

  return finalPath;
}

export class MapRecordNotFoundError extends Error {
  constructor(
    public readonly name: string,
    public readonly path: string,
  ) {
    super(`map record '${name}' not found at ${path}`);
    this.name = "MapRecordNotFoundError";
  }
}

/**
 * Read and parse `<repoRoot>/.prx/maps/<name>.json`. Throws
 * {@link MapRecordNotFoundError} when the file is absent so callers can
 * distinguish "no map yet" from a parse failure.
 */
export function readMapRecord(repoRoot: string, name: string): MapRecord {
  const path = mapFilePath(repoRoot, name);
  if (!existsSync(path)) {
    throw new MapRecordNotFoundError(name, path);
  }
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return MapRecord.parse(raw);
}

/**
 * List all map-record names under `<repoRoot>/.prx/maps/`. Returns an empty
 * array when the directory does not exist (first-run case). Hidden files
 * and the in-flight `.tmp.*` writes are skipped.
 */
export function listMapNames(repoRoot: string): string[] {
  const dir = mapsDir(repoRoot);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => !f.startsWith("."))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort();
}
