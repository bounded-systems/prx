import { processEnv } from "@bounded-systems/env";
import { defaultRunner as procRunner } from "@bounded-systems/proc";
import { basename } from "node:path";
import { listWorktrees, commandEnv, type CommandRunner as GithubCommandRunner } from "./github.ts";
import { CliError } from "./cli-error.ts";

// Extracted from packages/prx/src/pr-state/cli.ts by scripts/codemod/extract-module.ts — part of the
// §4 decomposition of the pr-state/cli.ts monolith into focused modules.

export const procSpawnLike: SpawnLike = (file, args, options) => {
  try {
    const result = procRunner([file, ...args], {
      cwd: options.cwd,
      env: options.env ?? processEnv(),
      check: false,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      status: null,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

export function runInheritStatus(
  cmd: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): number {
  try {
    return procRunner(cmd, { ...options, stdio: "inherit", check: false }).status;
  } catch {
    return 1;
  }
}

export type CommandRunnerResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error | undefined;
};

export function runCommand(command: string[], cwd = process.cwd()): CommandRunnerResult {
  const file = command[0] ?? "";
  const args = command.slice(1);
  try {
    const result = procRunner([file, ...args], {
      cwd,
      env: commandEnv(command),
      check: false,
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    return {
      status: null,
      stdout: "",
      stderr: "",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

export function tryCommand(command: string[], cwd?: string): string | null {
  const result = runCommand(command, cwd);

  if (result.status !== 0) {
    return null;
  }

  return result.stdout.trim() || null;
}

export type SpawnLikeResult = {
  status: number | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: Error;
};

export type SpawnLike = (
  file: string,
  args: string[],
  options: { cwd: string; encoding: "utf8"; env?: NodeJS.ProcessEnv },
) => SpawnLikeResult;

type WorktreeResolutionEntry = {
  branch: string;
  path: string;
  states: string[];
};

export function resolveRepoRootWithSpawn(
  cwd: string,
  spawn: SpawnLike,
): string {
  const repoRootResult = spawn("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (repoRootResult.error) {
    throw repoRootResult.error;
  }
  if ((repoRootResult.status ?? 1) !== 0) {
    const msg = (repoRootResult.stderr ?? repoRootResult.stdout ?? "").trim() || "git rev-parse failed";
    throw new CliError(msg);
  }
  return (repoRootResult.stdout ?? "").trim();
}

export function listResolvedWorktrees(
  repoRoot: string,
  runner: GithubCommandRunner,
): WorktreeResolutionEntry[] {
  // prx-native: read worktrees straight from git. Detached worktrees (branch
  // null) are kept with an empty branch so findWorktreeByDirectoryPrefix can
  // still match a drifted work-unit directory by its on-disk name.
  return listWorktrees(repoRoot, runner).map((entry) => ({
    branch: entry.branch ?? "",
    path: entry.path,
    states: [],
  }));
}

export function findWorktreeByDirectoryPrefix(
  entries: ReadonlyArray<WorktreeResolutionEntry>,
  workUnitId: string,
): WorktreeResolutionEntry | undefined {
  const normalized = workUnitId.toLowerCase();
  const match = /^([a-z]+)-(\d+)$/.exec(normalized);
  if (!match) {
    return undefined;
  }
  const prefix = `${match[1]}_${match[2]}_`;
  return entries.find((entry) => basename(entry.path).toLowerCase().startsWith(prefix));
}


