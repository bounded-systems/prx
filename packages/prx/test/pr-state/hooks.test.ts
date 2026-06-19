import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  applyHooks,
  formatHookApply,
  hookApplyHasErrors,
  hookStatus,
  hookStatusHasDrift,
} from "../../src/pr-state/hooks.ts";
import type { LocalRepo, RepoInventory, RepoRunner } from "../../src/pr-state/repos.ts";

function initTempGitRepo(prefix: string): { path: string; commonDir: string } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  const initResult = Bun.spawnSync({
    cmd: ["git", "init", path],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(initResult.exitCode).toBe(0);

  const commonDirResult = Bun.spawnSync({
    cmd: ["git", "-C", path, "rev-parse", "--git-common-dir"],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(commonDirResult.exitCode).toBe(0);

  const commonDirRaw = new TextDecoder().decode(commonDirResult.stdout).trim();
  const commonDir = isAbsolute(commonDirRaw) ? commonDirRaw : resolve(path, commonDirRaw);
  return { path, commonDir };
}

function makeInventoryForRepos(entries: Array<{ name: string; commonDir: string }>): RepoInventory {
  const repos: LocalRepo[] = entries.map((entry) => ({
    name: entry.name,
    kind: "standard",
    commonDir: entry.commonDir,
    mainWorktree: null,
    localOnlyBranches: [],
    findings: [],
    primaryRemote: null,
    upstreamRemote: null,
    remotes: [],
    worktrees: [],
  }));
  return { roots: [], repos };
}

function readHooksPath(commonDir: string): string | null {
  const result = Bun.spawnSync({
    cmd: ["git", "config", "--file", `${commonDir}/config`, "--get", "core.hooksPath"],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    return null;
  }
  const value = new TextDecoder().decode(result.stdout).trim();
  return value.length > 0 ? value : null;
}

describe("applyHooks", () => {
  test("writes core.hooksPath to each repo and reports changed state", () => {
    const alpha = initTempGitRepo("prx-hooks-alpha-");
    const beta = initTempGitRepo("prx-hooks-beta-");
    try {
      const inventory = makeInventoryForRepos([
        { name: "alpha", commonDir: alpha.commonDir },
        { name: "beta", commonDir: beta.commonDir },
      ]);
      const result = applyHooks(inventory, "/shared/hooks");

      expect(result.hooksPath).toBe("/shared/hooks");
      expect(result.repos).toHaveLength(2);
      expect(result.repos.every((r) => r.changed)).toBe(true);
      expect(result.repos.every((r) => r.previousHooksPath === null)).toBe(true);
      expect(hookApplyHasErrors(result)).toBe(false);

      expect(readHooksPath(alpha.commonDir)).toBe("/shared/hooks");
      expect(readHooksPath(beta.commonDir)).toBe("/shared/hooks");
    } finally {
      rmSync(alpha.path, { recursive: true, force: true });
      rmSync(beta.path, { recursive: true, force: true });
    }
  });

  test("is idempotent and reports unchanged state on repeat", () => {
    const repo = initTempGitRepo("prx-hooks-idempotent-");
    try {
      const inventory = makeInventoryForRepos([{ name: "repo", commonDir: repo.commonDir }]);
      applyHooks(inventory, "/shared/hooks");
      const second = applyHooks(inventory, "/shared/hooks");

      expect(second.repos[0]!.previousHooksPath).toBe("/shared/hooks");
      expect(second.repos[0]!.changed).toBe(false);
    } finally {
      rmSync(repo.path, { recursive: true, force: true });
    }
  });

  test("records error when git config fails and leaves other repos alone", () => {
    const repo = initTempGitRepo("prx-hooks-mixed-");
    try {
      const inventory = makeInventoryForRepos([
        { name: "good", commonDir: repo.commonDir },
        { name: "missing", commonDir: "/nonexistent/missing.git" },
      ]);
      const result = applyHooks(inventory, "/shared/hooks");

      expect(hookApplyHasErrors(result)).toBe(true);
      expect(result.repos[0]!.error).toBeUndefined();
      expect(result.repos[0]!.changed).toBe(true);
      expect(result.repos[1]!.error).toBeTruthy();
      expect(result.repos[1]!.changed).toBe(false);
      expect(readHooksPath(repo.commonDir)).toBe("/shared/hooks");
    } finally {
      rmSync(repo.path, { recursive: true, force: true });
    }
  });

  test("retries on .git/config lock contention then succeeds", () => {
    const inventory = makeInventoryForRepos([{ name: "racy", commonDir: "/fake/racy.git" }]);
    const writeCalls: string[][] = [];
    const lockErr = "error: could not lock config file /fake/racy.git/config: File exists\n";
    const runner: RepoRunner = (cmd) => {
      if (cmd.includes("--get")) {
        return { stdout: "", stderr: "", status: 1 };
      }
      writeCalls.push([...cmd]);
      if (writeCalls.length <= 2) {
        return { stdout: "", stderr: lockErr, status: 1 };
      }
      return { stdout: "", stderr: "", status: 0 };
    };
    const sleeps: number[] = [];
    const result = applyHooks(inventory, "/shared/hooks", runner, (ms) => {
      sleeps.push(ms);
    });

    expect(writeCalls).toHaveLength(3);
    expect(result.repos[0]!.error).toBeUndefined();
    expect(result.repos[0]!.lockRetries).toBe(2);
    expect(sleeps).toHaveLength(2);
  });

  test("gives up and records error after exhausting retry budget", () => {
    const inventory = makeInventoryForRepos([{ name: "stuck", commonDir: "/fake/stuck.git" }]);
    const writeCalls: string[][] = [];
    const lockErr = "error: could not lock config file /fake/stuck.git/config: File exists\n";
    const runner: RepoRunner = (cmd) => {
      if (cmd.includes("--get")) {
        return { stdout: "", stderr: "", status: 1 };
      }
      writeCalls.push([...cmd]);
      return { stdout: "", stderr: lockErr, status: 1 };
    };
    const result = applyHooks(inventory, "/shared/hooks", runner, () => {});

    expect(writeCalls).toHaveLength(5);
    expect(result.repos[0]!.error).toMatch(/could not lock config file/);
    expect(result.repos[0]!.lockRetries).toBeUndefined();
  });

  test("non-lock errors fail immediately without retry", () => {
    const inventory = makeInventoryForRepos([{ name: "broken", commonDir: "/fake/broken.git" }]);
    const writeCalls: string[][] = [];
    const runner: RepoRunner = (cmd) => {
      if (cmd.includes("--get")) {
        return { stdout: "", stderr: "", status: 1 };
      }
      writeCalls.push([...cmd]);
      return { stdout: "", stderr: "fatal: bad config\n", status: 1 };
    };
    const result = applyHooks(inventory, "/shared/hooks", runner, () => {});

    expect(writeCalls).toHaveLength(1);
    expect(result.repos[0]!.error).toBe("fatal: bad config");
    expect(result.repos[0]!.lockRetries).toBeUndefined();
  });

  test("formatHookApply surfaces (retried Nx) suffix when lockRetries > 0", () => {
    const text = formatHookApply(
      {
        hooksPath: "/shared/hooks",
        repos: [
          {
            name: "racy",
            commonDir: "/fake/racy.git",
            previousHooksPath: null,
            newHooksPath: "/shared/hooks",
            changed: true,
            lockRetries: 2,
          },
        ],
      },
      "plain",
    );

    expect(text).toContain("(retried 2x)");
  });
});

describe("hookStatus", () => {
  test("reports drift when core.hooksPath is unset or mismatched", () => {
    const alpha = initTempGitRepo("prx-hooks-status-alpha-");
    const beta = initTempGitRepo("prx-hooks-status-beta-");
    try {
      Bun.spawnSync({
        cmd: ["git", "-C", alpha.path, "config", "core.hooksPath", "/shared/hooks"],
        stdout: "pipe",
        stderr: "pipe",
      });
      const inventory = makeInventoryForRepos([
        { name: "alpha", commonDir: alpha.commonDir },
        { name: "beta", commonDir: beta.commonDir },
      ]);
      const result = hookStatus(inventory, "/shared/hooks");

      expect(hookStatusHasDrift(result)).toBe(true);
      expect(result.repos[0]!.matches).toBe(true);
      expect(result.repos[0]!.currentHooksPath).toBe("/shared/hooks");
      expect(result.repos[1]!.matches).toBe(false);
      expect(result.repos[1]!.currentHooksPath).toBeNull();
    } finally {
      rmSync(alpha.path, { recursive: true, force: true });
      rmSync(beta.path, { recursive: true, force: true });
    }
  });

  test("reports no drift when all repos match", () => {
    const repo = initTempGitRepo("prx-hooks-status-match-");
    try {
      Bun.spawnSync({
        cmd: ["git", "-C", repo.path, "config", "core.hooksPath", "/shared/hooks"],
        stdout: "pipe",
        stderr: "pipe",
      });
      const inventory = makeInventoryForRepos([{ name: "repo", commonDir: repo.commonDir }]);
      const result = hookStatus(inventory, "/shared/hooks");

      expect(hookStatusHasDrift(result)).toBe(false);
      expect(result.repos[0]!.matches).toBe(true);
    } finally {
      rmSync(repo.path, { recursive: true, force: true });
    }
  });
});
