// GH-1660 — materializeBareRepo() integration test against a real git fixture.
//
// Builds a tiny on-disk bare "remote", points the prx inventory at a target
// bare path that does not yet exist, and exercises the cloned → noop → fetched
// transitions by walking an injected clock past the TTL boundary.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { materializeBareRepo } from "../../src/pr-state/materialize.ts";
import { runCli } from "../../src/pr-state/cli.ts";

function mkTmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (cwd=${cwd}): ${result.stderr}`);
  }
}

describe("materializeBareRepo — integration", () => {
  let root: string;
  let remoteBare: string;
  let repoRoot: string;
  let bareRoot: string;
  let targetBarePath: string;

  beforeAll(() => {
    root = mkTmp("prx-materialize-int-");

    // 1. Build the upstream bare remote with one real commit.
    const seed = join(root, "seed");
    mkdirSync(seed, { recursive: true });
    git(seed, ["init", "--initial-branch=main"]);
    git(seed, ["config", "user.email", "test@example.com"]);
    git(seed, ["config", "user.name", "Test"]);
    writeFileSync(join(seed, "README.md"), "hello\n");
    git(seed, ["add", "."]);
    git(seed, ["commit", "-m", "seed"]);

    remoteBare = join(root, "remote.git");
    git(seed, ["clone", "--bare", seed, remoteBare]);

    // 2. Lay out an operator repo with a prx inventory pointing at our target.
    repoRoot = join(root, "operator");
    bareRoot = join(root, "bare");
    const prxDir = join(repoRoot, ".prx", "repos");
    mkdirSync(prxDir, { recursive: true });
    mkdirSync(bareRoot, { recursive: true });

    // operator must itself be a git repo for loadRepoInventoryConfig to find a repoRoot.
    git(repoRoot, ["init"]);

    targetBarePath = join(bareRoot, "io.github", "octo", "demo.git");

    writeFileSync(
      join(prxDir, "config.json"),
      JSON.stringify(
        { bareRoot, roots: [bareRoot], everywhereRoots: [bareRoot] },
        null,
        2,
      ),
    );
    writeFileSync(
      join(prxDir, "index.json"),
      JSON.stringify(
        {
          roots: [bareRoot],
          bareRoot,
          repos: [
            {
              name: "demo",
              commonDir: targetBarePath,
              kind: "bare",
              mainWorktree: null,
              worktrees: [],
              localOnlyBranches: [],
              findings: [],
              remotes: [
                { name: "origin", url: remoteBare, githubRepo: "octo/demo" },
              ],
              primaryRemote: { name: "origin", url: remoteBare, githubRepo: "octo/demo" },
              upstreamRemote: null,
            },
          ],
        },
        null,
        2,
      ),
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("cloned → noop → fetched as time advances past TTL", () => {
    const baseMs = Date.now();
    let nowMs = baseMs;

    // 1st call: barePath missing → cloned.
    const first = materializeBareRepo({
      name: "demo",
      cwd: repoRoot,
      ttlSeconds: 60,
      now: () => nowMs,
    });
    expect(first.action).toBe("cloned");
    expect(existsSync(join(targetBarePath, "FETCH_HEAD"))).toBe(true);

    // 2nd call within TTL → noop.
    const second = materializeBareRepo({
      name: "demo",
      cwd: repoRoot,
      ttlSeconds: 60,
      now: () => nowMs + 5_000,
    });
    expect(second.action).toBe("noop");

    // 3rd call after advancing past TTL → fetched.
    const third = materializeBareRepo({
      name: "demo",
      cwd: repoRoot,
      ttlSeconds: 60,
      now: () => nowMs + 120_000,
    });
    expect(third.action).toBe("fetched");
  });
});

// GH-1752 — `prx repo materialize` CLI handler now bootstraps mainx +
// rescans the inventory after the bare leg. End-to-end on a real fixture:
// the verb takes a registered slug with `mainWorktree: null` and produces
// the same ready-to-use shape as `prx repo add`.
//
// The inventory URL must parse through `parseRepoUrl` (the refresh leg
// needs `{host, owner, name}` to compute the mainx path). `parseRepoUrl`
// only accepts ssh / https / http / git protocols, so the fixture
// pre-populates the bare clone manually (from a file-path upstream),
// then sets the bare-freshness TTL high enough that `materializeBareRepo`
// takes the `noop` arm — no network fetch is attempted on the parseable
// URL. The refresh leg's downstream git ops (`git worktree add`,
// `git config`) all run against on-disk paths, not the remote URL.
describe("prx repo materialize CLI — end-to-end fixture", () => {
  let root: string;
  let remoteBare: string;
  let repoRoot: string;
  let bareRoot: string;
  let xdgStateHome: string;
  let wtRoot: string;
  let targetBarePath: string;
  let expectedMainxPath: string;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "prx-materialize-cli-")));

    // Upstream bare remote with one commit so cloning succeeds and
    // `origin/HEAD` resolves to a real ref.
    const seed = join(root, "seed");
    mkdirSync(seed, { recursive: true });
    git(seed, ["init", "--initial-branch=main"]);
    git(seed, ["config", "user.email", "test@example.com"]);
    git(seed, ["config", "user.name", "Test"]);
    writeFileSync(join(seed, "README.md"), "hello\n");
    git(seed, ["add", "."]);
    git(seed, ["commit", "-m", "seed"]);

    remoteBare = join(root, "remote.git");
    git(seed, ["clone", "--bare", seed, remoteBare]);

    repoRoot = join(root, "operator");
    bareRoot = join(root, "bare");
    xdgStateHome = join(root, "state");
    wtRoot = join(xdgStateHome, "wt", "worktrees");
    const prxDir = join(repoRoot, ".prx", "repos");
    mkdirSync(prxDir, { recursive: true });
    mkdirSync(bareRoot, { recursive: true });
    mkdirSync(wtRoot, { recursive: true });

    // operator must itself be a git repo so `loadRepoInventoryConfig`
    // resolves a repoRoot when the CLI runs from this cwd.
    git(repoRoot, ["init"]);

    targetBarePath = join(bareRoot, "io.github", "octo", "demo.git");
    expectedMainxPath = join(wtRoot, "demo.git", "mainx");

    // Pre-populate the registered bare path so `materializeBareRepo`
    // takes the `noop` arm (combined with a high TTL via prx.toml).
    // This sidesteps the parseable-but-unreachable URL in the inventory
    // without weakening what's under test: the new composition runs
    // exactly the same on the noop arm as on cloned / fetched.
    mkdirSync(join(bareRoot, "io.github", "octo"), { recursive: true });
    git(seed, ["clone", "--bare", seed, targetBarePath]);
    git(targetBarePath, ["remote", "set-url", "origin", remoteBare]);
    // Match the refspec shape that `addLocalRepo` writes (heads-only is
    // sufficient for `materializeMainxIfMissing` to resolve origin/<branch>).
    git(targetBarePath, [
      "config",
      "--add",
      "remote.origin.fetch",
      "+refs/heads/*:refs/remotes/origin/*",
    ]);
    // Populate refs/remotes/origin/* (and origin/HEAD) so the refresh
    // leg's `resolveDefaultBranch` + `git worktree add origin/main`
    // both find concrete refs on disk. Talks to the file-path remote,
    // never touches DNS.
    git(targetBarePath, ["fetch", "origin"]);
    git(targetBarePath, ["remote", "set-head", "origin", "--auto"]);
    // Touch FETCH_HEAD so the freshness check finds something mtime-able;
    // a long TTL via prx.toml keeps it in the noop arm.
    writeFileSync(join(targetBarePath, "FETCH_HEAD"), "");

    writeFileSync(
      join(repoRoot, "prx.toml"),
      "[wt]\nmaterialize_ttl_seconds = 86400\n",
    );

    writeFileSync(
      join(prxDir, "config.json"),
      JSON.stringify(
        { bareRoot, roots: [bareRoot], everywhereRoots: [bareRoot, wtRoot] },
        null,
        2,
      ),
    );
    writeFileSync(
      join(prxDir, "index.json"),
      JSON.stringify(
        {
          roots: [bareRoot],
          bareRoot,
          repos: [
            {
              name: "demo",
              commonDir: targetBarePath,
              kind: "bare",
              mainWorktree: null,
              worktrees: [],
              localOnlyBranches: [],
              findings: [],
              remotes: [
                {
                  name: "origin",
                  url: "https://example.invalid/octo/demo.git",
                  githubRepo: "octo/demo",
                },
              ],
              primaryRemote: {
                name: "origin",
                url: "https://example.invalid/octo/demo.git",
                githubRepo: "octo/demo",
              },
              upstreamRemote: null,
            },
          ],
        },
        null,
        2,
      ),
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("materialize: bare + mainx + inventory rescan flips mainWorktree from null to the resolved path", () => {
    const previousCwd = process.cwd();
    const previousXdg = process.env.XDG_STATE_HOME;
    const previousWtPath = process.env.WT_WORKTREE_PATH;
    const logs: string[] = [];
    const errors: string[] = [];
    let exitCode: number | Promise<number>;
    try {
      process.env.XDG_STATE_HOME = xdgStateHome;
      // Clear any inherited template so resolveWorktreePath uses our
      // XDG_STATE_HOME-derived base under the fixture root.
      delete process.env.WT_WORKTREE_PATH;
      process.chdir(repoRoot);
      exitCode = runCli(
        ["repo", "materialize", "demo", "--format", "json"],
        { log: (line) => logs.push(line), error: (line) => errors.push(line) },
      );
    } finally {
      process.chdir(previousCwd);
      if (previousXdg === undefined) {
        delete process.env.XDG_STATE_HOME;
      } else {
        process.env.XDG_STATE_HOME = previousXdg;
      }
      if (previousWtPath !== undefined) {
        process.env.WT_WORKTREE_PATH = previousWtPath;
      }
    }

    // Exit 0 only when beadsHydrate reported a success/skip status. The
    // fixture has no `.beads/` set up so hydrate short-circuits with
    // `skipped-no-beads` (exitCode 0). Anything non-zero would be a
    // regression in the composition.
    expect({ exitCode, errors }).toEqual({ exitCode: 0, errors: [] });
    expect(logs.length).toBeGreaterThan(0);
    expect(existsSync(targetBarePath)).toBe(true);
    expect(existsSync(expectedMainxPath)).toBe(true);

    const index = JSON.parse(
      readFileSync(join(repoRoot, ".prx", "repos", "index.json"), "utf8"),
    ) as {
      repos: Array<{
        name: string;
        mainWorktree: string | null;
        worktrees: Array<{ path: string }>;
      }>;
    };
    const entry = index.repos.find((r) => r.name === "demo");
    expect(entry).toBeDefined();
    // The post-write inventory rescan must have discovered the mainx as
    // an attached worktree — this is the bug fix from GH-1752 (operator
    // could not progress a registered-but-half-materialized repo because
    // `prx repo bootstrap` / `prx repo audit` refused with `no-worktree`
    // when the entry had `worktrees: []`). `resolvedRepoCwd` falls back
    // to `worktrees[0].path` when `mainWorktree` is null, so the
    // refusal is unreachable as soon as a worktree row exists.
    expect(entry!.worktrees.map((w) => w.path)).toContain(expectedMainxPath);
  });
});
