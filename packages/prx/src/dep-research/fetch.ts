// dep-research fetcher (GH-1274, PR-2 of GH-1261).
//
// PR-2 ships a minimal inline impl (shallow `git clone` + `curl`) wired
// behind a DI seam so tests can swap a fake `CommandRunner` and so the
// implementation can move under the GH-1245 fetch actor when that lands
// without changing call sites.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { defaultRunner } from "../pr-state/scope-inference.ts";
import type { CommandRunner } from "../pr-state/scope-inference.ts";
import type { DepManifestEntry } from "./schemas.ts";

/** Bytes per manifest path that fetched OK + reasons for paths that didn't. */
export type FetchResult = {
  paths: Record<string, Buffer>;
  failures: Record<string, string>;
};

/**
 * Fetches every path in `entry.source.paths` using `destDir` as scratch.
 * Per-path failures are isolated: one path failing does not abort the others.
 *
 * Async to match the eventual GH-1245 fetch-actor signature; the inline impl
 * is synchronous under the hood (the injected `CommandRunner` is sync).
 */
export type FetchSourceFn = (
  entry: DepManifestEntry,
  destDir: string,
) => Promise<FetchResult>;

/**
 * Default fetcher factory — shells `git clone` for `kind: "git"` and `curl`
 * for `kind: "docs"`. `npm` and `flake-input` are valid in the schema but
 * not exercised by any current manifest entry, so they surface as a clear
 * per-path failure rather than crashing the whole run.
 */
export function defaultFetchSource(
  runner: CommandRunner = defaultRunner,
): FetchSourceFn {
  return async (entry, destDir) => {
    if (entry.source.kind === "git") {
      return fetchGit(entry, destDir, runner);
    }
    if (entry.source.kind === "docs") {
      return fetchDocs(entry, destDir, runner);
    }
    return notImplemented(entry, entry.source.kind);
  };
}

/**
 * Top-level orchestrator. Thin wrapper around the injected `FetchSourceFn`
 * — kept as a named export so the CLI runtime branch and the future fetch
 * actor have a stable seam to call.
 */
export async function fetchSources(
  entry: DepManifestEntry,
  destDir: string,
  fetcher: FetchSourceFn,
): Promise<FetchResult> {
  return fetcher(entry, destDir);
}

function fetchGit(
  entry: DepManifestEntry,
  destDir: string,
  runner: CommandRunner,
): FetchResult {
  const cloneDir = join(destDir, "repo");
  const cloneResult = runner(
    "git",
    ["clone", "--depth=1", entry.source.url, cloneDir],
    { cwd: destDir },
  );
  if (cloneResult.status !== 0) {
    const reason =
      `git clone failed (${cloneResult.status ?? "?"}): ` +
      (cloneResult.stderr || cloneResult.stdout || "no output").trim();
    return allFailed(entry.source.paths, reason);
  }

  const paths: Record<string, Buffer> = {};
  const failures: Record<string, string> = {};
  for (const path of entry.source.paths) {
    try {
      paths[path] = readFileSync(join(cloneDir, path));
    } catch (err) {
      failures[path] = `read failed: ${(err as Error).message}`;
    }
  }
  return { paths, failures };
}

function fetchDocs(
  entry: DepManifestEntry,
  destDir: string,
  runner: CommandRunner,
): FetchResult {
  const baseUrl = entry.source.url.replace(/\/+$/, "");
  const paths: Record<string, Buffer> = {};
  const failures: Record<string, string> = {};

  for (const path of entry.source.paths) {
    const url = path.length === 0 ? baseUrl : `${baseUrl}/${path}`;
    const outFile = join(destDir, sanitizeForFs(path));
    const result = runner("curl", ["-fsSL", "-o", outFile, url], {
      cwd: destDir,
    });
    if (result.status !== 0) {
      failures[path] =
        `curl failed (${result.status ?? "?"}): ` +
        (result.stderr || result.stdout || "no output").trim();
      continue;
    }
    try {
      paths[path] = readFileSync(outFile);
    } catch (err) {
      failures[path] = `read failed: ${(err as Error).message}`;
    }
  }
  return { paths, failures };
}

function notImplemented(
  entry: DepManifestEntry,
  kind: string,
): FetchResult {
  return allFailed(
    entry.source.paths,
    `fetcher not yet implemented for kind: "${kind}"`,
  );
}

function allFailed(
  paths: readonly string[],
  reason: string,
): FetchResult {
  const failures: Record<string, string> = {};
  for (const path of paths) {
    failures[path] = reason;
  }
  return { paths: {}, failures };
}

function sanitizeForFs(path: string): string {
  // Slashes / colons / etc. would interpret as directory separators; the
  // scratch dir is flat. The original path is preserved as the dictionary
  // key in the FetchResult — this is just a stable filename.
  return path.replace(/[^A-Za-z0-9._-]/g, "_") || "_root";
}
