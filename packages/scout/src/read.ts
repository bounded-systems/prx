// GH-1384 PR-2 — third scout FS-exploration verb. Bounded text-only single
// file read. Sibling to scout/grep.ts and scout/files.ts; emits one JSON
// envelope so the dispatch envelope captures a single CAS record.

import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

// Scout's content-addressed reads use the CAS substrate's digest primitive,
// so the hash is computed in exactly one place across the provenance stack.
// Scout holds the bare-hex form on the wire (its `scout://sha256:…` handle
// re-adds the prefix); the prefixed `Digest` is the same bytes, wrapped.
import { sha256BareHex } from "@bounded-systems/cas";

export interface ScoutReadInput {
  /** Path to read. May be absolute, relative to `--in`, or relative to cwd. */
  path: string;
  /**
   * Directory to resolve `path` against. May be absolute, relative to cwd,
   * or a `GH-<n>` work-unit id (resolution intentionally deferred — raises
   * an explicit error so callers know to pass a path until the resolver
   * lands as a follow-up).
   */
  in?: string | undefined;
  /** Default 2 MiB; rejects oversized files explicitly. */
  maxBytes?: number | undefined;
  /** Working directory when `in` is omitted; defaults to process.cwd(). */
  cwd?: string;
}

export interface ScoutReadResult {
  path: string;
  sha256: string;
  bytes: number;
  lines: number;
  truncated: boolean;
  content: string;
}

export class ScoutReadError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "ScoutReadError";
    this.code = code;
  }
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

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
  ".nix",
  ".lock",
  ".env.example",
  ".gitignore",
  ".gitattributes",
  ".dockerignore",
  ".editorconfig",
  ".npmrc",
  ".tool-versions",
  ".prettierrc",
  ".eslintrc",
]);

function hasTextExt(name: string): boolean {
  const lower = name.toLowerCase();
  for (const ext of TEXT_EXTS) {
    if (lower.endsWith(ext)) return true;
  }
  // Files with no extension that are common text (Makefile, Dockerfile, etc.)
  // — match by basename for the long tail.
  const base = lower.split("/").pop() ?? lower;
  if (
    base === "makefile" ||
    base === "dockerfile" ||
    base === "readme" ||
    base === "license" ||
    base === "changelog"
  ) {
    return true;
  }
  return false;
}

// Heuristic binary detection: NUL byte in first 8 KiB. Belt-and-suspenders to
// the extension allowlist for files like `flake.lock` that aren't in TEXT_EXTS
// but are plain text, and to catch mislabeled extensions early.
function looksBinary(buf: Buffer): boolean {
  const probe = buf.subarray(0, Math.min(buf.length, 8192));
  for (let i = 0; i < probe.length; i++) {
    if (probe[i] === 0) return true;
  }
  return false;
}

function resolveTarget(input: ScoutReadInput): string {
  const cwd = input.cwd ?? process.cwd();
  if (input.in !== undefined && input.in.length > 0) {
    if (/^GH-\d+$/i.test(input.in)) {
      throw new ScoutReadError(
        `--in ${input.in}: GH-<n> resolution not yet implemented; pass a directory path`,
        "WORKUNIT_RESOLUTION_NOT_IMPLEMENTED",
      );
    }
    const root = isAbsolute(input.in) ? input.in : resolve(cwd, input.in);
    return isAbsolute(input.path) ? input.path : resolve(root, input.path);
  }
  return isAbsolute(input.path) ? input.path : resolve(cwd, input.path);
}

export async function runScoutRead(input: ScoutReadInput): Promise<ScoutReadResult> {
  if (typeof input.path !== "string" || input.path.length === 0) {
    throw new ScoutReadError("path must not be empty", "MISSING_PATH");
  }
  const requestedMax = input.maxBytes ?? DEFAULT_MAX_BYTES;
  if (requestedMax <= 0) {
    throw new ScoutReadError("maxBytes must be positive", "INVALID_MAX_BYTES");
  }
  const target = resolveTarget(input);
  // Open once and stat/read the same descriptor: the metadata checks and the
  // read then refer to the same inode, so the file can't be swapped between
  // check and use (CodeQL js/file-system-race).
  let fd: number;
  try {
    fd = openSync(target, "r");
  } catch {
    throw new ScoutReadError(`file not found: ${target}`, "FILE_NOT_FOUND");
  }
  let buf: Buffer;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new ScoutReadError(`path is not a regular file: ${target}`, "NOT_A_FILE");
    }
    if (stat.size > requestedMax) {
      throw new ScoutReadError(
        `file exceeds maxBytes (${stat.size} > ${requestedMax}): ${target}`,
        "FILE_TOO_LARGE",
      );
    }
    if (!hasTextExt(target)) {
      throw new ScoutReadError(
        `path is not a recognized text file (extension allowlist): ${target}`,
        "NOT_TEXT",
      );
    }
    buf = readFileSync(fd);
  } catch (err) {
    if (err instanceof ScoutReadError) throw err;
    throw new ScoutReadError(`read failed: ${(err as Error).message}`, "READ_FAILED");
  } finally {
    closeSync(fd);
  }
  if (looksBinary(buf)) {
    throw new ScoutReadError(`path looks binary (NUL byte in head): ${target}`, "BINARY_CONTENT");
  }
  const content = buf.toString("utf8");
  const sha256 = sha256BareHex(buf);
  const lines = content.length === 0 ? 0 : content.split("\n").length;
  return {
    path: target,
    sha256,
    bytes: buf.byteLength,
    lines,
    truncated: false,
    content,
  };
}

/**
 * Render a result as a single JSON object. The dispatch envelope writes this
 * stdout into CAS verbatim, so the resulting `scout://sha256:…` handle holds
 * the full file envelope in one record.
 */
export function formatScoutReadJson(result: ScoutReadResult): string {
  return JSON.stringify(result) + "\n";
}
