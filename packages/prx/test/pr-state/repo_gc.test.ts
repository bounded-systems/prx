import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import {
  formatRepoGcReport,
  RepoGcError,
  runRepoGc,
  type RepoGcReport,
} from "../../src/pr-state/repo_gc.ts";
import type { LocalRepo, RepoInventory, RepoInventoryConfig } from "../../src/pr-state/repos.ts";
import {
  canonicalMainxPathFromParsed,
  parseRepoUrl,
  writeRepoInventoryIndex,
} from "../../src/pr-state/repos.ts";

type EntryOverrides = Partial<LocalRepo>;

function makeEntry(name: string, commonDir: string, overrides: EntryOverrides = {}): LocalRepo {
  return {
    name,
    commonDir,
    kind: "bare",
    mainWorktree: null,
    worktrees: [],
    localOnlyBranches: [],
    findings: [],
    remotes: [],
    primaryRemote: {
      name: "origin",
      url: `git@github.com:owner/${name}.git`,
      githubRepo: `owner/${name}`,
    },
    upstreamRemote: null,
    ...overrides,
  };
}

type Fixture = {
  config: RepoInventoryConfig;
  wtRoot: string;
  homeDir: string;
  indexPath: string;
  root: string;
  /** Materialize the canonical mainx path for `<slug>` and return it. */
  workspacePath: (slug: string) => string;
};

function withFixture(repos: LocalRepo[]): Fixture {
  const root = mkdtempSync(join(tmpdir(), "prx-repo-gc-"));
  const repoRoot = join(root, "ai-home");
  const indexDir = join(repoRoot, ".prx", "repos");
  mkdirSync(indexDir, { recursive: true });
  const indexPath = join(indexDir, "index.json");
  const wtRoot = join(root, "wt");
  mkdirSync(wtRoot, { recursive: true });
  const homeDir = join(root, "home");
  mkdirSync(homeDir, { recursive: true });

  const inventory: RepoInventory = {
    roots: [],
    repos,
    bareRoot: join(root, "bare"),
    configPath: join(indexDir, "config.json"),
    indexPath,
    generatedAt: "2026-05-14T00:00:00.000Z",
  };
  writeRepoInventoryIndex(indexPath, inventory);

  const workspacePath = (slug: string): string => {
    const parsed = parseRepoUrl(`git@github.com:owner/${slug}.git`)!;
    const p = canonicalMainxPathFromParsed(wtRoot, parsed);
    mkdirSync(p, { recursive: true });
    return p;
  };

  return {
    config: {
      repoRoot,
      bareRoot: inventory.bareRoot ?? null,
      roots: [],
      everywhereRoots: [],
      globalConfigPath: null,
      configPath: inventory.configPath ?? null,
      indexPath,
    },
    wtRoot,
    homeDir,
    indexPath,
    root,
    workspacePath,
  };
}

describe("runRepoGc", () => {
  test("bd store retired: every scanned repo is nothing-to-clean, audit rows emitted", () => {
    const fx = withFixture([makeEntry("demo-repo", "/bare/ignored")]);

    const auditRows: { kind: string }[] = [];

    const report = runRepoGc(
      {
        config: fx.config,
        wtRoot: fx.wtRoot,
        apply: false,
        yes: false,
      },
      {
        homeDir: fx.homeDir,
        appendAuditRow: (row) => auditRows.push(row as { kind: string }),
      },
    );

    expect(report.scanned).toBe(1);
    expect(report.orphansFound).toBe(0);
    expect(report.swept).toBe(0);
    expect(report.refused).toBe(0);
    expect(report.cleanedBytes).toBe(0);
    expect(report.entries[0]!.action).toBe("nothing-to-clean");
    expect(report.entries[0]!.orphanPath).toBeNull();
    expect(auditRows.map((r) => r.kind)).toEqual(["repo-gc-entry", "repo-gc-run"]);
  });

  test("apply is a no-op: nothing swept even with apply + yes", () => {
    const fx = withFixture([makeEntry("demo-repo", "/bare/ignored")]);

    const report = runRepoGc(
      {
        config: fx.config,
        wtRoot: fx.wtRoot,
        apply: true,
        yes: true,
      },
      {
        homeDir: fx.homeDir,
        appendAuditRow: () => {},
      },
    );

    expect(report.swept).toBe(0);
    expect(report.cleanedBytes).toBe(0);
    expect(report.entries[0]!.action).toBe("nothing-to-clean");
  });

  test("idempotent: no orphans ever found → nothing-to-clean", () => {
    const fx = withFixture([makeEntry("alpha", "/bare/ignored")]);

    const report = runRepoGc(
      {
        config: fx.config,
        wtRoot: fx.wtRoot,
        apply: true,
        yes: true,
      },
      {
        homeDir: fx.homeDir,
        appendAuditRow: () => {},
      },
    );

    expect(report.orphansFound).toBe(0);
    expect(report.entries[0]!.action).toBe("nothing-to-clean");
  });

  test("slug narrowing: only the named slug is processed; unknown slug throws RepoGcError('no_such_slug')", () => {
    const fx = withFixture([makeEntry("alpha", "/bare/alpha"), makeEntry("beta", "/bare/beta")]);

    const report = runRepoGc(
      {
        config: fx.config,
        wtRoot: fx.wtRoot,
        slug: "alpha",
        apply: false,
        yes: false,
      },
      {
        homeDir: fx.homeDir,
        appendAuditRow: () => {},
      },
    );
    expect(report.scanned).toBe(1);
    expect(report.entries.map((e) => e.slug)).toEqual(["alpha"]);

    expect(() =>
      runRepoGc(
        {
          config: fx.config,
          wtRoot: fx.wtRoot,
          slug: "missing",
          apply: false,
          yes: false,
        },
        {
          homeDir: fx.homeDir,
          appendAuditRow: () => {},
        },
      ),
    ).toThrow(RepoGcError);
  });

  test("index errors: missing index path and missing inventory throw RepoGcError", () => {
    const fx = withFixture([makeEntry("alpha", "/bare/alpha")]);

    expect(() =>
      runRepoGc(
        {
          config: { ...fx.config, indexPath: null },
          wtRoot: fx.wtRoot,
          apply: false,
          yes: false,
        },
        { homeDir: fx.homeDir, appendAuditRow: () => {} },
      ),
    ).toThrow(RepoGcError);

    expect(() =>
      runRepoGc(
        {
          config: fx.config,
          wtRoot: fx.wtRoot,
          apply: false,
          yes: false,
        },
        {
          homeDir: fx.homeDir,
          loadRepoInventoryIndex: () => null,
          appendAuditRow: () => {},
        },
      ),
    ).toThrow(RepoGcError);
  });

  test("formatRepoGcReport: plain summary and json mode", () => {
    const report: RepoGcReport = {
      apply: false,
      scanned: 2,
      orphansFound: 1,
      swept: 0,
      refused: 0,
      cleanedBytes: 0,
      durationMs: 1,
      entries: [
        {
          slug: "alpha",
          commonDir: "/bare/alpha",
          workspacePath: "/wt/alpha.git/mainx",
          classification: "none",
          orphanPath: "/wt/alpha.git/mainx/orphan/alpha",
          orphanBytes: 33_000_000,
          action: "would-sweep",
        },
        {
          slug: "beta",
          commonDir: "/bare/beta",
          workspacePath: "/wt/beta.git/mainx",
          classification: "none",
          orphanPath: null,
          orphanBytes: null,
          action: "nothing-to-clean",
        },
      ],
    };
    const plain = formatRepoGcReport(report, "plain");
    expect(plain).toContain("would-sweep");
    expect(plain).toContain("nothing-to-clean");
    expect(plain).toContain("(dry-run)");
    const json = formatRepoGcReport(report, "json");
    expect(JSON.parse(json)).toMatchObject({ scanned: 2, orphansFound: 1 });
  });
});
