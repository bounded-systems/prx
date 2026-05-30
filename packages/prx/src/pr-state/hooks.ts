import type { LocalRepo, RepoInventory, RepoRunner } from "./repos.ts";
import { defaultRepoRunner } from "./repos.ts";

export type HookApplyEntry = {
  name: string;
  commonDir: string;
  previousHooksPath: string | null;
  newHooksPath: string;
  changed: boolean;
  error?: string;
  lockRetries?: number;
};

export type HookApplyResult = {
  hooksPath: string;
  repos: HookApplyEntry[];
};

export type HookStatusEntry = {
  name: string;
  commonDir: string;
  currentHooksPath: string | null;
  matches: boolean;
};

export type HookStatusResult = {
  hooksPath: string;
  repos: HookStatusEntry[];
};

function repoConfigPath(repo: LocalRepo): string {
  return `${repo.commonDir}/config`;
}

function readHooksPath(repo: LocalRepo, runner: RepoRunner): string | null {
  const result = runner(
    ["git", "config", "--file", repoConfigPath(repo), "--get", "core.hooksPath"],
    { check: false },
  );
  if (result.status !== 0) {
    return null;
  }
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

const LOCK_RETRY_LIMIT = 5;
const LOCK_BACKOFF_BASE_MS = 50;
const LOCK_BACKOFF_CAP_MS = 400;
const LOCK_JITTER_MS = 50;
const LOCK_ERROR = /could not lock config file [^\n]*: File exists/i;

function defaultSleepMs(ms: number): void {
  Bun.sleepSync(ms);
}

function writeHooksPath(
  repo: LocalRepo,
  hooksPath: string,
  runner: RepoRunner,
  sleepMs: (ms: number) => void = defaultSleepMs,
): { retries: number } {
  let lastErr = "";
  for (let attempt = 0; attempt < LOCK_RETRY_LIMIT; attempt++) {
    const result = runner(
      ["git", "config", "--file", repoConfigPath(repo), "core.hooksPath", hooksPath],
      { check: false },
    );
    if (result.status === 0) {
      return { retries: attempt };
    }
    lastErr = result.stderr.trim() || result.stdout.trim() || "git config failed";
    if (!LOCK_ERROR.test(result.stderr)) {
      throw new Error(lastErr);
    }
    if (attempt + 1 < LOCK_RETRY_LIMIT) {
      const backoff = Math.min(LOCK_BACKOFF_BASE_MS * 2 ** attempt, LOCK_BACKOFF_CAP_MS);
      sleepMs(backoff + Math.floor(Math.random() * LOCK_JITTER_MS));
    }
  }
  throw new Error(lastErr);
}

export function applyHooks(
  inventory: RepoInventory,
  hooksPath: string,
  runner: RepoRunner = defaultRepoRunner,
  sleepMs: (ms: number) => void = defaultSleepMs,
): HookApplyResult {
  const entries: HookApplyEntry[] = [];
  for (const repo of inventory.repos) {
    const previous = readHooksPath(repo, runner);
    try {
      const { retries } = writeHooksPath(repo, hooksPath, runner, sleepMs);
      entries.push({
        name: repo.name,
        commonDir: repo.commonDir,
        previousHooksPath: previous,
        newHooksPath: hooksPath,
        changed: previous !== hooksPath,
        lockRetries: retries,
      });
    } catch (err) {
      entries.push({
        name: repo.name,
        commonDir: repo.commonDir,
        previousHooksPath: previous,
        newHooksPath: hooksPath,
        changed: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { hooksPath, repos: entries };
}

export function hookStatus(
  inventory: RepoInventory,
  expectedPath: string,
  runner: RepoRunner = defaultRepoRunner,
): HookStatusResult {
  const entries: HookStatusEntry[] = [];
  for (const repo of inventory.repos) {
    const current = readHooksPath(repo, runner);
    entries.push({
      name: repo.name,
      commonDir: repo.commonDir,
      currentHooksPath: current,
      matches: current === expectedPath,
    });
  }
  return { hooksPath: expectedPath, repos: entries };
}

export function formatHookApply(result: HookApplyResult, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  const lines: string[] = [];
  lines.push(`hooks-path: ${result.hooksPath}`);
  if (result.repos.length === 0) {
    lines.push("  (no repos)");
    return lines.join("\n");
  }
  for (const repo of result.repos) {
    const retrySuffix = repo.lockRetries && repo.lockRetries > 0 ? ` (retried ${repo.lockRetries}x)` : "";
    if (repo.error) {
      lines.push(`  err    ${repo.name}  ${repo.error}`);
    } else if (repo.changed) {
      const prev = repo.previousHooksPath ?? "<unset>";
      lines.push(`  apply  ${repo.name}  ${prev} -> ${repo.newHooksPath}${retrySuffix}`);
    } else {
      lines.push(`  same   ${repo.name}  ${repo.newHooksPath}${retrySuffix}`);
    }
  }
  return lines.join("\n");
}

export function formatHookStatus(result: HookStatusResult, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  const lines: string[] = [];
  lines.push(`expected: ${result.hooksPath}`);
  if (result.repos.length === 0) {
    lines.push("  (no repos)");
    return lines.join("\n");
  }
  for (const repo of result.repos) {
    const mark = repo.matches ? "ok  " : "drift";
    const current = repo.currentHooksPath ?? "<unset>";
    lines.push(`  ${mark}  ${repo.name}  ${current}`);
  }
  return lines.join("\n");
}

export function hookApplyHasErrors(result: HookApplyResult): boolean {
  return result.repos.some((entry) => typeof entry.error === "string");
}

export function hookStatusHasDrift(result: HookStatusResult): boolean {
  return result.repos.some((entry) => !entry.matches);
}
