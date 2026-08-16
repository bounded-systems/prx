// GH-1660 — materializeBareRepo() unit tests.

import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// Isolate HOME/XDG so loadRepoInventoryConfig cannot fall back to the operator's
// real ~/.config/prx + ~/.local/state/prx index. Without this, the `writeIndex:
// false` case finds the operator's global index and reports `name_not_in_index`
// instead of `no_index_file`.
let prevHome: string | undefined;
let prevCfg: string | undefined;
let prevState: string | undefined;

beforeEach(() => {
  prevHome = process.env.HOME;
  prevCfg = process.env.XDG_CONFIG_HOME;
  prevState = process.env.XDG_STATE_HOME;
  const isolated = mkdtempSync(join(tmpdir(), "prx-materialize-home-"));
  process.env.HOME = isolated;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_STATE_HOME;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevCfg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevCfg;
  if (prevState === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = prevState;
});

import {
  DEFAULT_MATERIALIZE_TTL_SECONDS,
  loadMaterializeTtlSeconds,
  MaterializeError,
  materializeBareRepo,
} from "../../src/pr-state/materialize.ts";
import type { RepoRunner } from "../../src/pr-state/repos.ts";

type RunnerCall = { cmd: string[]; cwd: string | undefined };

type Scenario = {
  repoRoot: string;
  bareRoot: string;
  cwd: string;
  barePath: string;
};

function makeScenario(
  options: {
    indexEntries?: Array<{
      name: string;
      commonDir: string;
      primaryRemoteUrl: string | null;
      githubRepo?: string | null;
    }>;
    writeIndex?: boolean;
    tomlBody?: string;
  } = {},
): Scenario {
  const root = mkdtempSync(join(tmpdir(), "prx-materialize-"));
  const repoRoot = join(root, "operator");
  const bareRoot = join(root, "bare");
  const prxDir = join(repoRoot, ".prx", "repos");
  mkdirSync(prxDir, { recursive: true });
  mkdirSync(bareRoot, { recursive: true });

  writeFileSync(
    join(prxDir, "config.json"),
    JSON.stringify({ bareRoot, roots: [bareRoot], everywhereRoots: [bareRoot] }, null, 2),
  );

  const defaultBarePath = join(bareRoot, "io.github", "octo", "demo.git");
  const entries = options.indexEntries ?? [
    {
      name: "demo",
      commonDir: defaultBarePath,
      primaryRemoteUrl: "https://example.com/octo/demo.git",
      githubRepo: "octo/demo",
    },
  ];

  if (options.writeIndex !== false) {
    const indexBody = {
      roots: [bareRoot],
      bareRoot,
      configPath: join(prxDir, "config.json"),
      indexPath: join(prxDir, "index.json"),
      repos: entries.map((entry) => ({
        name: entry.name,
        commonDir: entry.commonDir,
        kind: "bare" as const,
        mainWorktree: null,
        worktrees: [],
        localOnlyBranches: [],
        findings: [],
        remotes: entry.primaryRemoteUrl
          ? [
              {
                name: "origin",
                url: entry.primaryRemoteUrl,
                githubRepo: entry.githubRepo ?? null,
              },
            ]
          : [],
        primaryRemote: entry.primaryRemoteUrl
          ? {
              name: "origin",
              url: entry.primaryRemoteUrl,
              githubRepo: entry.githubRepo ?? null,
            }
          : null,
        upstreamRemote: null,
      })),
    };
    writeFileSync(join(prxDir, "index.json"), `${JSON.stringify(indexBody, null, 2)}\n`);
  }

  if (options.tomlBody !== undefined) {
    writeFileSync(join(repoRoot, "prx.toml"), options.tomlBody);
  }

  return {
    repoRoot,
    bareRoot,
    cwd: repoRoot,
    barePath: entries[0]!.commonDir,
  };
}

function makeRunner(
  responses: Record<string, { stdout?: string; stderr?: string; status?: number }> = {},
): { runner: RepoRunner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];
  const runner: RepoRunner = (cmd, options = {}) => {
    calls.push({ cmd, cwd: options.cwd });
    const key = cmd.join(" ");
    if (key === "git rev-parse --show-toplevel") {
      return { stdout: `${options.cwd ?? ""}\n`, stderr: "", status: 0 };
    }
    const response = responses[key];
    return {
      stdout: response?.stdout ?? "",
      stderr: response?.stderr ?? "",
      status: response?.status ?? 0,
    };
  };
  return { runner, calls };
}

function gitCalls(calls: RunnerCall[]): string[][] {
  return calls
    .filter((call) => call.cmd[0] === "git" && call.cmd[1] !== "rev-parse")
    .map((call) => call.cmd);
}

describe("materializeBareRepo — terminal arms", () => {
  test("cloned: missing barePath triggers clone + fetch-refspec + fetch", () => {
    const scenario = makeScenario();
    const { runner, calls } = makeRunner();

    const result = materializeBareRepo({
      name: "demo",
      cwd: scenario.cwd,
      runner,
      now: () => 1_700_000_000_000,
    });

    expect(result.action).toBe("cloned");
    expect(result.repo).toBe("demo");
    expect(result.barePath).toBe(scenario.barePath);
    expect(result.dryRun).toBe(false);

    expect(gitCalls(calls)).toEqual([
      ["git", "clone", "--bare", "https://example.com/octo/demo.git", scenario.barePath],
      [
        "git",
        "-C",
        scenario.barePath,
        "config",
        "--add",
        "remote.origin.fetch",
        "+refs/heads/*:refs/remotes/origin/*",
      ],
      ["git", "-C", scenario.barePath, "fetch", "origin"],
    ]);
  });

  test("fetched: existing barePath with stale FETCH_HEAD triggers fetch --all --prune", () => {
    const scenario = makeScenario();
    mkdirSync(scenario.barePath, { recursive: true });
    const fetchHead = join(scenario.barePath, "FETCH_HEAD");
    writeFileSync(fetchHead, "");
    // Force mtime back ~1h.
    const oldSeconds = Math.floor(Date.now() / 1000) - 3600;
    utimesSync(fetchHead, oldSeconds, oldSeconds);

    const { runner, calls } = makeRunner();

    const result = materializeBareRepo({
      name: "demo",
      cwd: scenario.cwd,
      runner,
      ttlSeconds: 60,
      now: () => Date.now(),
    });

    expect(result.action).toBe("fetched");
    expect(gitCalls(calls)).toEqual([
      ["git", "-C", scenario.barePath, "fetch", "--all", "--prune"],
    ]);
  });

  test("noop: existing barePath with fresh FETCH_HEAD performs zero git work", () => {
    const scenario = makeScenario();
    mkdirSync(scenario.barePath, { recursive: true });
    const nowMs = 1_700_000_000_000;
    const fetchHead = join(scenario.barePath, "FETCH_HEAD");
    writeFileSync(fetchHead, "");
    const freshSec = nowMs / 1000 - 5; // 5s old; well under the 60s TTL
    utimesSync(fetchHead, freshSec, freshSec);
    // prx-4p0: a "current" bare carries origin tracking refs. Without one, a
    // fresh FETCH_HEAD is no longer treated as noop (it forces a fetch).
    mkdirSync(join(scenario.barePath, "refs", "remotes", "origin"), { recursive: true });
    writeFileSync(join(scenario.barePath, "refs", "remotes", "origin", "main"), "");

    const { runner, calls } = makeRunner();

    const result = materializeBareRepo({
      name: "demo",
      cwd: scenario.cwd,
      runner,
      ttlSeconds: 60,
      now: () => nowMs,
    });

    expect(result.action).toBe("noop");
    expect(gitCalls(calls)).toEqual([]);
  });

  test("prx-4p0: fresh FETCH_HEAD but no origin tracking refs forces a fetch", () => {
    const scenario = makeScenario();
    mkdirSync(scenario.barePath, { recursive: true });
    const nowMs = 1_700_000_000_000;
    const fetchHead = join(scenario.barePath, "FETCH_HEAD");
    writeFileSync(fetchHead, "");
    const freshSec = nowMs / 1000 - 5; // fresh, well under TTL
    utimesSync(fetchHead, freshSec, freshSec);
    // No refs/remotes/origin/* on disk (buffer-mirror clone / origin added but
    // never fetched). Despite the fresh FETCH_HEAD, this must not be a noop —
    // otherwise the downstream mainx bootstrap fails resolving origin/<default>.

    const { runner, calls } = makeRunner();

    const result = materializeBareRepo({
      name: "demo",
      cwd: scenario.cwd,
      runner,
      ttlSeconds: 60,
      now: () => nowMs,
    });

    expect(result.action).toBe("fetched");
    expect(gitCalls(calls)).toEqual([
      ["git", "-C", scenario.barePath, "fetch", "--all", "--prune"],
    ]);
  });
});

describe("materializeBareRepo — typed errors", () => {
  test("throws name_not_in_index when slug is unknown", () => {
    const scenario = makeScenario();
    const { runner } = makeRunner();
    try {
      materializeBareRepo({ name: "missing-slug", cwd: scenario.cwd, runner });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MaterializeError);
      expect((err as MaterializeError).code).toBe("name_not_in_index");
    }
  });

  test("throws no_index_file when index.json is missing", () => {
    const scenario = makeScenario({ writeIndex: false });
    const { runner } = makeRunner();
    try {
      materializeBareRepo({ name: "demo", cwd: scenario.cwd, runner });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MaterializeError);
      expect((err as MaterializeError).code).toBe("no_index_file");
    }
  });

  test("throws no_primary_remote when entry has no remote", () => {
    const scenario = makeScenario({
      indexEntries: [
        {
          name: "demo",
          commonDir: join(tmpdir(), "prx-materialize-x", "demo.git"),
          primaryRemoteUrl: null,
        },
      ],
    });
    const { runner } = makeRunner();
    try {
      materializeBareRepo({ name: "demo", cwd: scenario.cwd, runner });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MaterializeError);
      expect((err as MaterializeError).code).toBe("no_primary_remote");
    }
  });

  test("throws ambiguous_name when slug matches multiple bare repos", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-materialize-amb-"));
    const repoRoot = join(root, "operator");
    const bareRoot = join(root, "bare");
    const prxDir = join(repoRoot, ".prx", "repos");
    mkdirSync(prxDir, { recursive: true });
    mkdirSync(bareRoot, { recursive: true });
    writeFileSync(
      join(prxDir, "config.json"),
      JSON.stringify({ bareRoot, roots: [bareRoot], everywhereRoots: [bareRoot] }),
    );
    writeFileSync(
      join(prxDir, "index.json"),
      JSON.stringify({
        roots: [bareRoot],
        bareRoot,
        repos: [
          {
            name: "demo",
            commonDir: join(bareRoot, "a", "demo.git"),
            kind: "bare",
            mainWorktree: null,
            worktrees: [],
            localOnlyBranches: [],
            findings: [],
            remotes: [],
            primaryRemote: { name: "origin", url: "https://a/demo.git", githubRepo: "a/demo" },
            upstreamRemote: null,
          },
          {
            name: "demo",
            commonDir: join(bareRoot, "b", "demo.git"),
            kind: "bare",
            mainWorktree: null,
            worktrees: [],
            localOnlyBranches: [],
            findings: [],
            remotes: [],
            primaryRemote: { name: "origin", url: "https://b/demo.git", githubRepo: "b/demo" },
            upstreamRemote: null,
          },
        ],
      }),
    );
    const { runner } = makeRunner();
    try {
      materializeBareRepo({ name: "demo", cwd: repoRoot, runner });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MaterializeError);
      expect((err as MaterializeError).code).toBe("ambiguous_name");
    }
  });
});

describe("materializeBareRepo — dry-run", () => {
  test("dry-run for cloned arm computes action without running git", () => {
    const scenario = makeScenario();
    const { runner, calls } = makeRunner();

    const result = materializeBareRepo({
      name: "demo",
      cwd: scenario.cwd,
      runner,
      dryRun: true,
    });

    expect(result).toMatchObject({ action: "cloned", dryRun: true });
    expect(existsSync(scenario.barePath)).toBe(false);
    expect(gitCalls(calls)).toEqual([]);
  });

  test("dry-run for fetched arm computes action without running git", () => {
    const scenario = makeScenario();
    mkdirSync(scenario.barePath, { recursive: true });
    const fetchHead = join(scenario.barePath, "FETCH_HEAD");
    writeFileSync(fetchHead, "");
    const stale = Math.floor(Date.now() / 1000) - 7200;
    utimesSync(fetchHead, stale, stale);

    const { runner, calls } = makeRunner();
    const result = materializeBareRepo({
      name: "demo",
      cwd: scenario.cwd,
      runner,
      dryRun: true,
      ttlSeconds: 60,
    });

    expect(result).toMatchObject({ action: "fetched", dryRun: true });
    expect(gitCalls(calls)).toEqual([]);
  });

  test("dry-run for noop arm computes action without running git", () => {
    const scenario = makeScenario();
    mkdirSync(scenario.barePath, { recursive: true });
    const nowMs = 1_700_000_000_000;
    const fetchHead = join(scenario.barePath, "FETCH_HEAD");
    writeFileSync(fetchHead, "");
    const fresh = nowMs / 1000 - 5;
    utimesSync(fetchHead, fresh, fresh);
    // prx-4p0: origin tracking ref present so the fresh bare resolves to noop.
    mkdirSync(join(scenario.barePath, "refs", "remotes", "origin"), { recursive: true });
    writeFileSync(join(scenario.barePath, "refs", "remotes", "origin", "main"), "");

    const { runner, calls } = makeRunner();
    const result = materializeBareRepo({
      name: "demo",
      cwd: scenario.cwd,
      runner,
      dryRun: true,
      ttlSeconds: 60,
      now: () => nowMs,
    });

    expect(result).toMatchObject({ action: "noop", dryRun: true });
    expect(gitCalls(calls)).toEqual([]);
  });
});

describe("loadMaterializeTtlSeconds — TOML precedence", () => {
  test("returns default when prx.toml is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-materialize-toml-"));
    expect(loadMaterializeTtlSeconds(root)).toBe(DEFAULT_MATERIALIZE_TTL_SECONDS);
  });

  test("reads [wt] materialize_ttl_seconds from prx.toml", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-materialize-toml-"));
    writeFileSync(join(root, "prx.toml"), "[wt]\nmaterialize_ttl_seconds = 9\n");
    expect(loadMaterializeTtlSeconds(root)).toBe(9);
  });

  test("ignores materialize_ttl_seconds outside the [wt] section", () => {
    const root = mkdtempSync(join(tmpdir(), "prx-materialize-toml-"));
    writeFileSync(join(root, "prx.toml"), "[beads]\nmaterialize_ttl_seconds = 9\n");
    expect(loadMaterializeTtlSeconds(root)).toBe(DEFAULT_MATERIALIZE_TTL_SECONDS);
  });

  test("explicit ttlSeconds beats prx.toml and default", () => {
    const scenario = makeScenario({ tomlBody: "[wt]\nmaterialize_ttl_seconds = 5\n" });
    mkdirSync(scenario.barePath, { recursive: true });
    const nowMs = 1_700_000_000_000;
    const fetchHead = join(scenario.barePath, "FETCH_HEAD");
    writeFileSync(fetchHead, "");
    // 7s old: stale under the 5s TOML value, but fresh under an explicit 100s.
    const stamp = nowMs / 1000 - 7;
    utimesSync(fetchHead, stamp, stamp);
    // prx-4p0: origin tracking ref present so freshness resolves to noop.
    mkdirSync(join(scenario.barePath, "refs", "remotes", "origin"), { recursive: true });
    writeFileSync(join(scenario.barePath, "refs", "remotes", "origin", "main"), "");

    const { runner, calls } = makeRunner();

    const result = materializeBareRepo({
      name: "demo",
      cwd: scenario.cwd,
      runner,
      ttlSeconds: 100,
      now: () => nowMs,
    });

    expect(result.action).toBe("noop");
    expect(gitCalls(calls)).toEqual([]);
  });

  test("prx.toml beats default when no explicit ttlSeconds", () => {
    const scenario = makeScenario({ tomlBody: "[wt]\nmaterialize_ttl_seconds = 5\n" });
    mkdirSync(scenario.barePath, { recursive: true });
    const nowMs = 1_700_000_000_000;
    const fetchHead = join(scenario.barePath, "FETCH_HEAD");
    writeFileSync(fetchHead, "");
    // 10s old — stale under 5s TOML; would be fresh under the 60s default.
    const stamp = nowMs / 1000 - 10;
    utimesSync(fetchHead, stamp, stamp);

    const { runner, calls } = makeRunner();
    const result = materializeBareRepo({
      name: "demo",
      cwd: scenario.cwd,
      runner,
      now: () => nowMs,
    });

    expect(result.action).toBe("fetched");
    expect(gitCalls(calls)).toEqual([
      ["git", "-C", scenario.barePath, "fetch", "--all", "--prune"],
    ]);
  });
});
