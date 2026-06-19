import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureWorkUnitBranchAndUpstream,
  formatEnsureWorkUnitBranchResult,
} from "../../src/tools/ensure_work_unit_branch.ts";

type Fixture = {
  root: string;
  origin: string;
  work: string;
};

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr || r.stdout}`);
  }
  return (r.stdout ?? "").trim();
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "prx-ensure-wu-branch-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");

  spawnSync("git", ["init", "--bare", "--initial-branch=main", origin], {
    encoding: "utf8",
  });
  spawnSync("git", ["init", "--initial-branch=main", work], { encoding: "utf8" });
  git(work, "config", "user.email", "test@example.com");
  git(work, "config", "user.name", "Test");
  git(work, "config", "commit.gpgsign", "false");
  git(work, "config", "tag.gpgsign", "false");
  git(work, "config", "gpg.format", "openpgp");
  git(work, "remote", "add", "origin", origin);
  writeFileSync(join(work, "README.md"), "hello\n");
  git(work, "add", "README.md");
  git(work, "commit", "-m", "init");
  git(work, "push", "-u", "origin", "main");

  return { root, origin, work };
}

function remoteHas(origin: string, branch: string): boolean {
  const r = spawnSync(
    "git",
    ["--git-dir", origin, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    { encoding: "utf8" },
  );
  return r.status === 0;
}

function localHas(cwd: string, branch: string): boolean {
  const r = spawnSync(
    "git",
    ["-C", cwd, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    { encoding: "utf8" },
  );
  return r.status === 0;
}

function upstreamOf(cwd: string, branch: string): string {
  const r = spawnSync(
    "git",
    ["-C", cwd, "branch", "--list", branch, "--format=%(upstream:short)"],
    { encoding: "utf8" },
  );
  return (r.stdout ?? "").trim();
}

describe("ensureWorkUnitBranchAndUpstream", () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    rmSync(fx.root, { recursive: true, force: true });
  });

  test("remote missing + local missing: creates origin/<id>, creates local tracking", () => {
    const result = ensureWorkUnitBranchAndUpstream({ id: "GH-900", cwd: fx.work });
    expect(result.status).toBe("created-tracking");
    expect(result.localCreated).toBe(true);
    expect(result.upstreamChanged).toBe(false);
    expect(result.remote.status).toBe("created");
    expect(remoteHas(fx.origin, "GH-900")).toBe(true);
    expect(localHas(fx.work, "GH-900")).toBe(true);
    expect(upstreamOf(fx.work, "GH-900")).toBe("origin/GH-900");
  });

  test("remote exists + local missing: creates local tracking (the session-open bug repro)", () => {
    git(fx.work, "push", "origin", "main:refs/heads/GH-901");
    git(fx.work, "fetch", "origin");
    expect(localHas(fx.work, "GH-901")).toBe(false);

    const result = ensureWorkUnitBranchAndUpstream({ id: "GH-901", cwd: fx.work });
    expect(result.status).toBe("created-tracking");
    expect(result.localCreated).toBe(true);
    expect(result.remote.status).toBe("exists-remote");
    expect(localHas(fx.work, "GH-901")).toBe(true);
    expect(upstreamOf(fx.work, "GH-901")).toBe("origin/GH-901");
  });

  test("remote exists + local exists + upstream unset: sets upstream", () => {
    git(fx.work, "push", "origin", "main:refs/heads/GH-902");
    git(fx.work, "fetch", "origin");
    git(fx.work, "branch", "GH-902");
    expect(upstreamOf(fx.work, "GH-902")).toBe("");

    const result = ensureWorkUnitBranchAndUpstream({ id: "GH-902", cwd: fx.work });
    expect(result.status).toBe("upstream-fixed");
    expect(result.upstreamChanged).toBe(true);
    expect(result.localCreated).toBe(false);
    expect(upstreamOf(fx.work, "GH-902")).toBe("origin/GH-902");
  });

  test("remote exists + local exists + upstream already correct: ok, no changes", () => {
    git(fx.work, "push", "origin", "main:refs/heads/GH-903");
    git(fx.work, "fetch", "origin");
    git(fx.work, "branch", "--track", "GH-903", "origin/GH-903");
    expect(upstreamOf(fx.work, "GH-903")).toBe("origin/GH-903");

    const result = ensureWorkUnitBranchAndUpstream({ id: "GH-903", cwd: fx.work });
    expect(result.status).toBe("ok");
    expect(result.localCreated).toBe(false);
    expect(result.upstreamChanged).toBe(false);
  });

  test("upstream points elsewhere: returns upstream-mismatch, does NOT silently rewrite", () => {
    git(fx.work, "push", "origin", "main:refs/heads/GH-904");
    git(fx.work, "push", "origin", "main:refs/heads/other-branch");
    git(fx.work, "fetch", "origin");
    git(fx.work, "branch", "--track", "GH-904", "origin/other-branch");
    expect(upstreamOf(fx.work, "GH-904")).toBe("origin/other-branch");

    const result = ensureWorkUnitBranchAndUpstream({ id: "GH-904", cwd: fx.work });
    expect(result.status).toBe("upstream-mismatch");
    expect(result.upstreamChanged).toBe(false);
    expect(result.message).toContain("origin/other-branch");
    expect(result.message).toContain("origin/GH-904");
    expect(upstreamOf(fx.work, "GH-904")).toBe("origin/other-branch");
  });

  test("skip list: no-op, never touches remote or local", () => {
    const result = ensureWorkUnitBranchAndUpstream({
      id: "main",
      cwd: fx.work,
    });
    expect(result.status).toBe("skipped");
    expect(result.localCreated).toBe(false);
    expect(result.upstreamChanged).toBe(false);
  });

  test("malformed base surfaces as error (not swallowed)", () => {
    const result = ensureWorkUnitBranchAndUpstream({
      id: "GH-bad-base",
      base: "no-slash",
      cwd: fx.work,
    });
    expect(result.status).toBe("error");
    expect(result.message).toContain("invalid --base");
  });

  test("does not create or mutate a worktree", () => {
    const before = git(fx.work, "worktree", "list", "--porcelain");
    ensureWorkUnitBranchAndUpstream({ id: "GH-905", cwd: fx.work });
    const after = git(fx.work, "worktree", "list", "--porcelain");
    expect(after).toBe(before);
  });
});

describe("formatEnsureWorkUnitBranchResult", () => {
  test("json round-trips the structured result", () => {
    const result = {
      status: "created-tracking" as const,
      id: "GH-1",
      upstream: "origin/GH-1",
      remote: {
        status: "created" as const,
        branch: "GH-1",
        base: "origin/main",
        remote: "origin",
        created: true,
      },
      localCreated: true,
      upstreamChanged: false,
    };
    const parsed = JSON.parse(formatEnsureWorkUnitBranchResult(result, "json"));
    expect(parsed).toEqual(result);
  });

  test("plain format tags each status distinctly", () => {
    const base = {
      remote: {
        status: "exists-remote" as const,
        branch: "GH-1",
        base: "origin/main",
        remote: "origin",
        created: false,
      },
      localCreated: false,
      upstreamChanged: false,
    };
    expect(
      formatEnsureWorkUnitBranchResult(
        { status: "ok", id: "GH-1", upstream: "origin/GH-1", ...base },
        "plain",
      ),
    ).toBe("ok: GH-1 -> origin/GH-1");

    expect(
      formatEnsureWorkUnitBranchResult(
        {
          status: "upstream-fixed",
          id: "GH-1",
          upstream: "origin/GH-1",
          ...base,
          upstreamChanged: true,
        },
        "plain",
      ),
    ).toBe("upstream-fixed: GH-1 -> origin/GH-1");

    expect(
      formatEnsureWorkUnitBranchResult(
        {
          status: "upstream-mismatch",
          id: "GH-1",
          upstream: "origin/GH-1",
          ...base,
          message: "branch GH-1 upstream is origin/other, expected origin/GH-1",
        },
        "plain",
      ),
    ).toBe(
      "upstream-mismatch: GH-1 -> origin/GH-1 — branch GH-1 upstream is origin/other, expected origin/GH-1",
    );
  });
});
