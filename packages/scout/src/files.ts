// GH-1384 PR-1 — second scout FS-exploration verb. Bounded glob walk: list
// repo files matching a glob pattern. Sibling to scout/grep.ts; emits one
// JSON-line `{path}` per match plus a trailing `_summary` line so the
// dispatch envelope writes a clean CAS payload.

import { readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface ScoutFilesInput {
  /** Glob pattern, e.g. star-star slash star dot nix. Matched against each file's relative path. */
  pattern: string;
  /**
   * Directory to search. May be an absolute path, a path relative to cwd,
   * or a `GH-<n>` work-unit id (resolution intentionally deferred — raises
   * an explicit error so callers know to pass a path until the resolver
   * lands as a follow-up).
   */
  in?: string | undefined;
  /** Default 200; capped at 5000 to bound the CAS blob the dispatch writes. */
  maxResults?: number;
  /** Working directory when `in` is omitted; defaults to process.cwd(). */
  cwd?: string;
}

export interface ScoutFilesMatch {
  path: string;
}

export interface ScoutFilesResult {
  root: string;
  pattern: string;
  matches: ScoutFilesMatch[];
  truncated: boolean;
  filesScanned: number;
}

export class ScoutFilesError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "ScoutFilesError";
    this.code = code;
  }
}

const DEFAULT_MAX_RESULTS = 200;
const HARD_MAX_RESULTS = 5000;

const SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".prx",
  ".pr",
  ".beads",
  ".ai-home",
  ".cache",
  ".turbo",
  "coverage",
  ".next",
]);

function resolveSearchRoot(input: ScoutFilesInput): string {
  const cwd = input.cwd ?? process.cwd();
  if (input.in === undefined || input.in.length === 0) {
    return cwd;
  }
  if (/^GH-\d+$/i.test(input.in)) {
    throw new ScoutFilesError(
      `--in ${input.in}: GH-<n> resolution not yet implemented; pass a directory path`,
      "WORKUNIT_RESOLUTION_NOT_IMPLEMENTED",
    );
  }
  return isAbsolute(input.in) ? input.in : resolve(cwd, input.in);
}

// Compile a glob pattern into a RegExp anchored on the relative path. Supports
// `*` (any chars within a segment), `**` (any path span including `/`), `?`,
// and `[...]` character classes. All other regex metacharacters are escaped.
function compileGlob(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i] as string;
    if (ch === "*") {
      const next = pattern[i + 1];
      if (next === "*") {
        // `**` matches any path span. Optional surrounding `/` is consumed
        // when written as `**/` so `**/*.nix` matches both `a.nix` and
        // `nested/a.nix`.
        const after = pattern[i + 2];
        if (after === "/") {
          re += "(?:.*/)?";
          i += 3;
          continue;
        }
        re += ".*";
        i += 2;
        continue;
      }
      // Single `*` matches any chars except `/`.
      re += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    if (ch === "[") {
      // Pass character class through (escape inner `\`).
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) {
        // Unclosed bracket — treat as literal.
        re += "\\[";
        i += 1;
        continue;
      }
      re += pattern.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    if (/[.+^$(){}|\\]/.test(ch)) {
      re += "\\" + ch;
      i += 1;
      continue;
    }
    re += ch;
    i += 1;
  }
  try {
    return new RegExp("^" + re + "$");
  } catch (err) {
    throw new ScoutFilesError(
      `invalid pattern: ${(err as Error).message}`,
      "INVALID_PATTERN",
    );
  }
}

interface WalkContext {
  root: string;
  re: RegExp;
  matches: ScoutFilesMatch[];
  maxResults: number;
  filesScanned: number;
  truncated: boolean;
}

function walkDir(ctx: WalkContext, dir: string): void {
  if (ctx.truncated) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (ctx.truncated) return;
    if (entry.name.startsWith(".") && SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkDir(ctx, full);
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = relative(ctx.root, full);
    ctx.filesScanned += 1;
    if (!ctx.re.test(rel)) continue;
    ctx.matches.push({ path: rel });
    if (ctx.matches.length >= ctx.maxResults) {
      ctx.truncated = true;
      return;
    }
  }
}

export async function runScoutFiles(
  input: ScoutFilesInput,
): Promise<ScoutFilesResult> {
  if (typeof input.pattern !== "string" || input.pattern.length === 0) {
    throw new ScoutFilesError("pattern must not be empty", "MISSING_PATTERN");
  }
  const requestedMax = input.maxResults ?? DEFAULT_MAX_RESULTS;
  if (requestedMax <= 0) {
    throw new ScoutFilesError(
      "maxResults must be positive",
      "INVALID_MAX_RESULTS",
    );
  }
  const maxResults = Math.min(requestedMax, HARD_MAX_RESULTS);
  const root = resolveSearchRoot(input);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(root);
  } catch {
    throw new ScoutFilesError(
      `search root not found: ${root}`,
      "ROOT_NOT_FOUND",
    );
  }
  if (!stat.isDirectory()) {
    throw new ScoutFilesError(
      `search root is not a directory: ${root}`,
      "ROOT_NOT_DIRECTORY",
    );
  }
  const re = compileGlob(input.pattern);
  const ctx: WalkContext = {
    root,
    re,
    matches: [],
    maxResults,
    filesScanned: 0,
    truncated: false,
  };
  walkDir(ctx, root);
  return {
    root,
    pattern: input.pattern,
    matches: ctx.matches,
    truncated: ctx.truncated,
    filesScanned: ctx.filesScanned,
  };
}

/**
 * Render a result as JSON-lines. Each match becomes one line of
 * `{"path":"..."}`. The trailing summary line is a single object
 * `{"_summary":{...}}` so consumers can detect truncation without
 * re-scanning. Mirrors formatScoutGrepJsonLines so the dispatch envelope
 * captures the same shape across scout verbs.
 */
export function formatScoutFilesJsonLines(result: ScoutFilesResult): string {
  const out: string[] = [];
  for (const m of result.matches) {
    out.push(JSON.stringify(m));
  }
  out.push(
    JSON.stringify({
      _summary: {
        root: result.root,
        pattern: result.pattern,
        matches: result.matches.length,
        truncated: result.truncated,
        filesScanned: result.filesScanned,
      },
    }),
  );
  return out.join("\n") + "\n";
}
