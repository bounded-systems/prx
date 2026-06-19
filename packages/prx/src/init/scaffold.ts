/**
 * Repo-scoped scaffold for the cross-agent convention layer (GH-357).
 *
 * Writes:
 *   - <repo>/AGENTS.md           — portable cross-agent baseline
 *   - <repo>/.claude/settings.json — project-scope Claude allowlist (GH-1378)
 *
 * Each file is independently idempotent: present → skipped, absent →
 * created, present-with-`--force` → forced. No-op on subsequent runs.
 */

import { spawnCapture } from "@bounded-systems/proc";
import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { buildAgentsMd } from "./agents_md.ts";
import { claudeSettingsJson } from "./claude_settings.ts";

export type ScaffoldOutcome = "created" | "skipped" | "forced";

export type ScaffoldResult = {
  repoRoot: string;
  files: Array<{
    path: string;
    outcome: ScaffoldOutcome;
  }>;
};

type SpawnResult = {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: Error;
};

export type ScaffoldSpawn = (
  file: string,
  args: string[],
  options: { cwd: string; encoding: "utf8" },
) => SpawnResult;

export type PathKind = "missing" | "file" | "directory" | "symlink" | "other";

export type ScaffoldFs = {
  exists: (path: string) => boolean;
  kind: (path: string) => PathKind;
  mkdir: (path: string) => void;
  writeFile: (path: string, contents: string) => void;
};

export type ScaffoldDeps = {
  cwd?: string;
  spawn?: ScaffoldSpawn;
  fs?: ScaffoldFs;
};

export type ScaffoldOptions = {
  force?: boolean;
};

function defaultKind(path: string): PathKind {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return "missing";
  }
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  return "other";
}

const defaultFs: ScaffoldFs = {
  exists: (path) => existsSync(path),
  kind: defaultKind,
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  writeFile: (path, contents) => writeFileSync(path, contents),
};

function defaultSpawn(
  file: string,
  args: string[],
  opts: { cwd: string; encoding: "utf8" },
): SpawnResult {
  const r = spawnCapture([file, ...args], { cwd: opts.cwd });
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    ...(r.error ? { error: r.error } : {}),
  };
}

function resolveRepoRoot(spawn: ScaffoldSpawn, cwd: string): string | null {
  const result = spawn("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (result.error) return null;
  if ((result.status ?? 1) !== 0) return null;
  const stdout =
    typeof result.stdout === "string" ? result.stdout : (result.stdout?.toString() ?? "");
  const trimmed = stdout.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export type ScaffoldErrorCode = "NOT_A_GIT_REPO" | "PATH_TYPE_CONFLICT";

export class ScaffoldError extends Error {
  constructor(
    message: string,
    public readonly code: ScaffoldErrorCode,
  ) {
    super(message);
    this.name = "ScaffoldError";
  }
}

export function scaffoldRepo(
  options: ScaffoldOptions = {},
  deps: ScaffoldDeps = {},
): ScaffoldResult {
  const cwd = deps.cwd ?? process.cwd();
  const spawn = deps.spawn ?? defaultSpawn;
  const fs = deps.fs ?? defaultFs;
  const force = options.force === true;

  const repoRoot = resolveRepoRoot(spawn, cwd);
  if (!repoRoot) {
    throw new ScaffoldError(
      "prx init: not in a git repository (git rev-parse --show-toplevel failed). Run `git init` first.",
      "NOT_A_GIT_REPO",
    );
  }

  const targets: Array<{ path: string; contents: string }> = [
    { path: join(repoRoot, "AGENTS.md"), contents: buildAgentsMd() },
    { path: join(repoRoot, ".claude", "settings.json"), contents: claudeSettingsJson() },
  ];

  const files: ScaffoldResult["files"] = [];
  for (const target of targets) {
    const targetKind = fs.kind(target.path);
    if (targetKind !== "missing" && targetKind !== "file") {
      throw new ScaffoldError(
        `prx init: cannot scaffold ${target.path}: path exists as ${targetKind} (expected file or absent). Resolve manually before re-running.`,
        "PATH_TYPE_CONFLICT",
      );
    }
    const present = targetKind === "file";
    if (present && !force) {
      files.push({ path: target.path, outcome: "skipped" });
      continue;
    }
    const dir = dirname(target.path);
    const dirKind = fs.kind(dir);
    if (dirKind === "missing") {
      fs.mkdir(dir);
    } else if (dirKind !== "directory") {
      throw new ScaffoldError(
        `prx init: cannot scaffold ${target.path}: parent ${dir} exists as ${dirKind} (expected directory). Resolve manually before re-running.`,
        "PATH_TYPE_CONFLICT",
      );
    }
    fs.writeFile(target.path, target.contents);
    files.push({ path: target.path, outcome: present ? "forced" : "created" });
  }

  return { repoRoot, files };
}

export function formatScaffoldResult(result: ScaffoldResult, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  const lines: string[] = [];
  for (const file of result.files) {
    lines.push(`${file.outcome.padEnd(7)} ${file.path}`);
  }
  lines.push("");
  lines.push("Next: prx tui  |  prx plan session GH-<n>");
  return lines.join("\n");
}
