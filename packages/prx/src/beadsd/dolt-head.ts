// GH-296 — read a beads clone's dolt HEAD hash (the dataset etag / generation).
//
// dolt is content-addressed, so `hashof('HEAD')` is one cheap hash for the whole
// store. Used as the freshness signal for caches and the sync push short-circuit.
// Best-effort: any failure (no dolt dir, server down, parse miss) returns
// undefined so callers degrade to "unknown" rather than throwing.

import { readdirSync } from "node:fs";

import { defaultRunner as procRunner, type CommandRunner } from "@bounded-systems/proc";

export type ReadDoltHeadDeps = {
  /** Spawn runner (sanctioned proc; tests inject a fake). */
  run?: CommandRunner | undefined;
  /** List the dolt dir's entries (defaults to `fs.readdirSync`); tests inject. */
  listDbDirs?: ((doltRoot: string) => string[]) | undefined;
};

/**
 * The dolt HEAD hash for the beads clone at `cloneCwd` (its dolt db lives at
 * `<cloneCwd>/.beads/dolt/<reverse-dns-db>`), or undefined when it can't be read.
 */
export function readDoltHead(cloneCwd: string, deps: ReadDoltHeadDeps = {}): string | undefined {
  const run = deps.run ?? procRunner;
  const listDbDirs =
    deps.listDbDirs ??
    ((doltRoot: string): string[] =>
      readdirSync(doltRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name));
  try {
    const doltRoot = `${cloneCwd}/.beads/dolt`;
    const db = listDbDirs(doltRoot)[0];
    if (db === undefined) return undefined;
    const r = run(["dolt", "sql", "-q", "select hashof('HEAD')", "-r", "csv"], {
      cwd: `${doltRoot}/${db}`,
      check: false,
    });
    if (r.status !== 0) return undefined;
    const last = r.stdout.trim().split("\n").pop()?.trim();
    return last && last !== "head" ? last : undefined;
  } catch {
    return undefined;
  }
}
