// First scout FS-exploration verb (GH-1193 child landed under GH-1194 to
// give the dispatch envelope a working target). Scoped to a bounded grep:
// walk a directory, scan text files for a pattern, emit JSON-lines.
//
// Independent of dispatch — also reachable as `prx scout grep …` directly.
// The dispatch envelope (handler.ts) just captures the verb's stdout into a
// CAS blob and emits a `scout://sha256:…` handle.

import { closeSync, fstatSync, openSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface ScoutGrepInput {
  pattern: string;
  /**
   * Directory to search. May be an absolute path, a path relative to cwd,
   * or a `GH-<n>` work-unit id (resolved against the wt worktree layout —
   * not implemented yet, raises an explicit error so callers know to pass a
   * path until the resolver lands as a follow-up).
   */
  in?: string | undefined;
  /**
   * Optional path-prefix filter applied to every match's relative path. The
   * filter is a literal prefix (not a glob) for now to keep the surface
   * tight; a glob form can replace it without breaking callers.
   */
  pathPrefix?: string | undefined;
  /** Default 200; capped at 5000 to bound the CAS blob the dispatch writes. */
  maxResults?: number | undefined;
  /** Working directory when `in` is omitted; defaults to process.cwd(). */
  cwd?: string | undefined;
}

export interface ScoutGrepMatch {
  path: string;
  line: number;
  content: string;
}

export interface ScoutGrepResult {
  root: string;
  pattern: string;
  matches: ScoutGrepMatch[];
  truncated: boolean;
  filesScanned: number;
}

export class ScoutGrepError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "ScoutGrepError";
    this.code = code;
  }
}

const DEFAULT_MAX_RESULTS = 200;
const HARD_MAX_RESULTS = 5000;
const HARD_MAX_FILE_BYTES = 2 * 1024 * 1024;

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

const TEXT_EXTS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".md",
  ".mdx",
  ".yml",
  ".yaml",
  ".toml",
  ".sh",
  ".bash",
  ".zsh",
  ".py",
  ".rs",
  ".go",
  ".html",
  ".css",
  ".scss",
  ".sql",
  ".env.example",
]);

function isTextFile(name: string): boolean {
  const lower = name.toLowerCase();
  for (const ext of TEXT_EXTS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

function resolveSearchRoot(input: ScoutGrepInput): string {
  const cwd = input.cwd ?? process.cwd();
  if (input.in === undefined || input.in.length === 0) {
    return cwd;
  }
  // GH-<n> resolution intentionally deferred. Surfacing an explicit error
  // beats a silent fallback that searches cwd when the operator typed a
  // work-unit id.
  if (/^GH-\d+$/i.test(input.in)) {
    throw new ScoutGrepError(
      `--in ${input.in}: GH-<n> resolution not yet implemented; pass a directory path`,
      "WORKUNIT_RESOLUTION_NOT_IMPLEMENTED",
    );
  }
  return isAbsolute(input.in) ? input.in : resolve(cwd, input.in);
}

function compilePattern(pattern: string): RegExp {
  // Surfacing regex errors early gives the caller a clean
  // INVALID_PATTERN code rather than a generic JS SyntaxError.
  try {
    return new RegExp(pattern);
  } catch (err) {
    throw new ScoutGrepError(
      `invalid pattern: ${(err as Error).message}`,
      "INVALID_PATTERN",
    );
  }
}

interface WalkContext {
  root: string;
  re: RegExp;
  prefix: string | undefined;
  matches: ScoutGrepMatch[];
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
    if (!isTextFile(entry.name)) continue;
    const rel = relative(ctx.root, full);
    if (ctx.prefix !== undefined && !rel.startsWith(ctx.prefix)) continue;
    // Open once, then stat and read the same descriptor so the size gate and
    // the read refer to one inode (CodeQL js/file-system-race).
    let fd: number;
    try {
      fd = openSync(full, "r");
    } catch {
      continue;
    }
    let body: string;
    try {
      if (fstatSync(fd).size > HARD_MAX_FILE_BYTES) continue;
      body = readFileSync(fd, "utf8");
    } catch {
      continue;
    } finally {
      closeSync(fd);
    }
    ctx.filesScanned += 1;
    const lines = body.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (ctx.re.test(line)) {
        ctx.matches.push({ path: rel, line: i + 1, content: line });
        if (ctx.matches.length >= ctx.maxResults) {
          ctx.truncated = true;
          return;
        }
      }
    }
  }
}

export async function runScoutGrep(
  input: ScoutGrepInput,
): Promise<ScoutGrepResult> {
  if (typeof input.pattern !== "string" || input.pattern.length === 0) {
    throw new ScoutGrepError("pattern must not be empty", "MISSING_PATTERN");
  }
  const requestedMax = input.maxResults ?? DEFAULT_MAX_RESULTS;
  if (requestedMax <= 0) {
    throw new ScoutGrepError(
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
    throw new ScoutGrepError(`search root not found: ${root}`, "ROOT_NOT_FOUND");
  }
  if (!stat.isDirectory()) {
    throw new ScoutGrepError(
      `search root is not a directory: ${root}`,
      "ROOT_NOT_DIRECTORY",
    );
  }
  const re = compilePattern(input.pattern);
  const ctx: WalkContext = {
    root,
    re,
    prefix: input.pathPrefix,
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
 * `{"path":"...","line":N,"content":"..."}`. The trailing summary line is
 * a single object `{"_summary":{...}}` so consumers can detect truncation
 * without re-scanning. The dispatch envelope writes this stdout into CAS
 * verbatim.
 */
export function formatScoutGrepJsonLines(result: ScoutGrepResult): string {
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
