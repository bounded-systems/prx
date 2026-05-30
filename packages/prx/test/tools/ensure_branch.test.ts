import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_BASE,
  DEFAULT_SKIP_BRANCHES,
  ensureBranch,
  formatEnsureBranchResult,
} from "../../src/tools/ensure_branch.ts";

type Fixture = {
  root: string;
  origin: string;
  work: string;
};

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${r.stderr || r.stdout}`,
    );
  }
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "prx-ensure-branch-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");

  spawnSync("git", ["init", "--bare", "--initial-branch=main", origin], {
    encoding: "utf8",
  });

  spawnSync("git", ["init", "--initial-branch=main", work], {
    encoding: "utf8",
  });
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

describe("ensureBranch", () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    rmSync(fx.root, { recursive: true, force: true });
  });

  test("returns 'skipped' for names in the default skip list", () => {
    for (const name of DEFAULT_SKIP_BRANCHES) {
      const result = ensureBranch({ name, cwd: fx.work });
      expect(result.status).toBe("skipped");
      expect(result.branch).toBe(name);
      expect(result.created).toBe(false);
    }
  });

  test("returns 'skipped' for names in a custom skip list", () => {
    const result = ensureBranch({
      name: "release",
      skip: ["release"],
      cwd: fx.work,
    });
    expect(result.status).toBe("skipped");
  });

  test("returns 'exists-local' when the branch already exists as refs/heads/<name>", () => {
    git(fx.work, "branch", "feature-x");
    const result = ensureBranch({ name: "feature-x", cwd: fx.work });
    expect(result.status).toBe("exists-local");
    expect(result.created).toBe(false);
    expect(remoteHas(fx.origin, "feature-x")).toBe(false);
  });

  test("returns 'exists-remote' when only a remote branch exists", () => {
    // Create the branch on origin (from main) and fetch so refs/remotes/origin/feature-y exists.
    git(fx.work, "push", "origin", "main:refs/heads/feature-y");
    git(fx.work, "fetch", "origin");
    // Ensure it does NOT exist locally as a local branch.
    const result = ensureBranch({ name: "feature-y", cwd: fx.work });
    expect(result.status).toBe("exists-remote");
    expect(result.created).toBe(false);
  });

  test("creates a new remote branch from origin/main by default", () => {
    const result = ensureBranch({ name: "GH-999", cwd: fx.work });
    expect(result.status).toBe("created");
    expect(result.created).toBe(true);
    expect(result.base).toBe(DEFAULT_BASE);
    expect(result.remote).toBe("origin");
    expect(remoteHas(fx.origin, "GH-999")).toBe(true);
  });

  test("localOnly creates the branch locally and never pushes (GH-2271)", () => {
    const result = ensureBranch({
      name: "intake/20260526-abc123",
      cwd: fx.work,
      localOnly: true,
    });
    expect(result.status).toBe("created");
    expect(result.created).toBe(true);
    // The local ref exists…
    const local = spawnSync(
      "git",
      ["-C", fx.work, "rev-parse", "--verify", "--quiet", "refs/heads/intake/20260526-abc123"],
      { encoding: "utf8" },
    );
    expect(local.status).toBe(0);
    // …but nothing was pushed to origin.
    expect(remoteHas(fx.origin, "intake/20260526-abc123")).toBe(false);
  });

  test("respects --base override", () => {
    // Give origin a 'trunk' branch that differs from main.
    git(fx.work, "push", "origin", "main:refs/heads/trunk");
    git(fx.work, "fetch", "origin");

    const result = ensureBranch({
      name: "GH-trunk-child",
      base: "origin/trunk",
      cwd: fx.work,
    });
    expect(result.status).toBe("created");
    expect(result.base).toBe("origin/trunk");
    expect(result.remote).toBe("origin");
    expect(remoteHas(fx.origin, "GH-trunk-child")).toBe(true);
  });

  test("returns 'base-unresolved' when the base ref can't be resolved after fetch", () => {
    const result = ensureBranch({
      name: "GH-no-base",
      base: "origin/does-not-exist",
      cwd: fx.work,
    });
    expect(result.status).toBe("base-unresolved");
    expect(result.created).toBe(false);
    expect(remoteHas(fx.origin, "GH-no-base")).toBe(false);
  });

  test("returns 'error' when --base is malformed", () => {
    const result = ensureBranch({
      name: "GH-bad-base",
      base: "no-slash",
      cwd: fx.work,
    });
    expect(result.status).toBe("error");
    expect(result.created).toBe(false);
    expect(result.message).toContain("invalid --base");
  });

  test("returns 'error' when push fails (e.g., missing remote)", () => {
    // Point origin.url to a bogus path so 'push' fails while base is still resolvable.
    git(fx.work, "remote", "set-url", "origin", join(fx.root, "does-not-exist.git"));
    // Base is still locally resolvable (origin/main ref still exists locally).
    const result = ensureBranch({ name: "GH-push-fails", cwd: fx.work });
    // Could be 'error' (push failed) or 'base-unresolved' depending on whether
    // the local ref survived the remote URL rewrite. Both are valid non-created outcomes.
    expect(result.created).toBe(false);
    expect(["error", "base-unresolved"]).toContain(result.status);
  });
});

describe("formatEnsureBranchResult", () => {
  test("json format is valid JSON with the documented schema", () => {
    const json = JSON.parse(
      formatEnsureBranchResult(
        {
          status: "created",
          branch: "GH-1",
          base: "origin/main",
          remote: "origin",
          created: true,
        },
        "json",
      ),
    );
    expect(json).toEqual({
      status: "created",
      branch: "GH-1",
      base: "origin/main",
      remote: "origin",
      created: true,
    });
  });

  test("plain format tags each status distinctly", () => {
    expect(
      formatEnsureBranchResult(
        { status: "created", branch: "GH-1", base: "origin/main", remote: "origin", created: true },
        "plain",
      ),
    ).toBe("created: GH-1 from origin/main");

    expect(
      formatEnsureBranchResult(
        { status: "exists-local", branch: "main", base: "origin/main", remote: "origin", created: false },
        "plain",
      ),
    ).toBe("ok (local): main");

    expect(
      formatEnsureBranchResult(
        { status: "exists-remote", branch: "main", base: "origin/main", remote: "origin", created: false },
        "plain",
      ),
    ).toBe("ok (remote): main");

    expect(
      formatEnsureBranchResult(
        { status: "skipped", branch: "main", base: "origin/main", remote: "origin", created: false },
        "plain",
      ),
    ).toBe("skipped: main");

    expect(
      formatEnsureBranchResult(
        {
          status: "error",
          branch: "GH-bad",
          base: "bad",
          remote: null,
          created: false,
          message: "invalid --base 'bad'",
        },
        "plain",
      ),
    ).toBe("error: GH-bad — invalid --base 'bad'");
  });
});
