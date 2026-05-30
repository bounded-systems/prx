/**
 * Tests for primary-vs-feature worktree classification (GH-653).
 *
 * Uses real `git init` + `git worktree add` fixtures so the structural
 * detection actually exercises git's gitdir / common-dir wiring rather
 * than mocking the only thing the helper does.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  isPrimaryWorktree,
  resolveMainWorktree,
} from "../../src/beads/primary_worktree.ts";

function mkTmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function gitInit(cwd: string): void {
  const r = spawnSync("git", ["init", "-q", "-b", "main"], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git init failed: ${r.stderr}`);
  // Configure committer so subsequent commits don't fail in CI environments.
  spawnSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  spawnSync("git", ["-C", cwd, "config", "user.name", "test"]);
  spawnSync("git", ["-C", cwd, "config", "commit.gpgsign", "false"]);
}

function gitCommit(cwd: string, msg: string): void {
  writeFileSync(join(cwd, "seed.txt"), `${msg}\n`);
  spawnSync("git", ["-C", cwd, "add", "seed.txt"]);
  const r = spawnSync(
    "git",
    ["-C", cwd, "commit", "-q", "-m", msg],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`git commit failed: ${r.stderr}`);
}

type Fixture = {
  primary: string;
  worktree: string;
  cleanup: () => void;
};

function makePrimaryAndLinked(): Fixture {
  const root = mkTmp("primary-worktree-");
  const primary = join(root, "primary");
  mkdirSync(primary, { recursive: true });
  gitInit(primary);
  gitCommit(primary, "seed");
  const worktree = join(root, "linked");
  const r = spawnSync(
    "git",
    ["-C", primary, "worktree", "add", "-q", "-b", "feature", worktree],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`git worktree add failed: ${r.stderr}`);
  return {
    primary,
    worktree,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("resolveMainWorktree", () => {
  let fixture: Fixture;
  afterEach(() => fixture?.cleanup());

  test("returns the primary path when called from a linked worktree", () => {
    fixture = makePrimaryAndLinked();
    const main = resolveMainWorktree(fixture.worktree);
    expect(main).not.toBeNull();
    expect(resolve(main!)).toBe(resolve(fixture.primary));
  });

  test("returns the same path when called from the primary itself", () => {
    fixture = makePrimaryAndLinked();
    const main = resolveMainWorktree(fixture.primary);
    expect(main).not.toBeNull();
    expect(resolve(main!)).toBe(resolve(fixture.primary));
  });

  test("returns null on a path that doesn't exist (git fails)", () => {
    // Triggers git's nonzero exit deterministically — covers the null
    // branch without depending on filesystem isolation from the host repo.
    expect(resolveMainWorktree("/nonexistent/definitely/not/a/path-XYZ")).toBeNull();
  });
});

describe("isPrimaryWorktree", () => {
  let fixture: Fixture;
  afterEach(() => fixture?.cleanup());

  test("true on the primary worktree", () => {
    fixture = makePrimaryAndLinked();
    expect(isPrimaryWorktree(fixture.primary)).toBe(true);
  });

  test("false on a linked feature worktree", () => {
    fixture = makePrimaryAndLinked();
    expect(isPrimaryWorktree(fixture.worktree)).toBe(false);
  });

  test("null when git fails (caller must map to a skip status)", () => {
    expect(isPrimaryWorktree("/nonexistent/definitely/not/a/path-XYZ")).toBeNull();
  });
});

/**
 * GH-1680: load-bearing regression — `resolveMainWorktree` returns `null`
 * for a worktree linked off a bare clone (e.g. `<bareRoot>/<name>.git` →
 * `<wtRoot>/<name>.git/mainx`). The classifier's regex (`primary_worktree.ts`)
 * requires a path component literally named `.git`, so a common-dir like
 * `<bareRoot>/<name>.git` (directory named `<name>.git`, not `.git`) yields
 * null. `hydrate()` then skips the GH-653 feature-worktree guard and
 * proceeds with primary-style hydration of mainx — which is what `prx repo
 * add` needs (the mainx is the canonical primary for the bare clone). If
 * this regex is ever relaxed to match `.git$` rather than `/\.git$`, the
 * post-add hydrate would mis-classify the bare-cloned mainx as a feature
 * worktree and skip without populating `.beads/dolt/`.
 */
describe("resolveMainWorktree on bare-cloned mainx (GH-1680)", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  function makeBareWithMainx(): { mainx: string; bare: string } {
    const root = mkTmp("bare-mainx-");
    cleanup = () => rmSync(root, { recursive: true, force: true });

    const seed = join(root, "seed");
    mkdirSync(seed, { recursive: true });
    gitInit(seed);
    gitCommit(seed, "seed");

    const bare = join(root, "scratch.git");
    const cloneResult = spawnSync(
      "git",
      ["clone", "--bare", "-q", seed, bare],
      { encoding: "utf8" },
    );
    if (cloneResult.status !== 0) {
      throw new Error(`git clone --bare failed: ${cloneResult.stderr}`);
    }

    const mainx = join(root, "scratch.git-mainx");
    const wtResult = spawnSync(
      "git",
      ["-C", bare, "worktree", "add", "-q", "--detach", mainx, "main"],
      { encoding: "utf8" },
    );
    if (wtResult.status !== 0) {
      throw new Error(`git worktree add failed: ${wtResult.stderr}`);
    }
    return { mainx, bare };
  }

  test("resolveMainWorktree returns null for a mainx worktree linked off a bare clone", () => {
    const { mainx } = makeBareWithMainx();
    // common-dir resolves to `<bareRoot>/scratch.git`, a directory whose
    // basename is `scratch.git` (not `.git`). The regex bails → null.
    expect(resolveMainWorktree(mainx)).toBeNull();
  });

  test("isPrimaryWorktree returns null for the same shape", () => {
    const { mainx } = makeBareWithMainx();
    expect(isPrimaryWorktree(mainx)).toBeNull();
  });
});
