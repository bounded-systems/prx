import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  /** Write `.beads/metadata.json` + ensure the shared-server dolt root exists. */
  setupSharedServer: (slug: string, dbName: string) => string;
  /** Drop a `.beads/embeddeddolt/<dbName>/<...>` orphan and return its path. */
  seedOrphan: (slug: string, dbName: string, bytes?: number) => string;
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
  const setupSharedServer = (slug: string, dbName: string): string => {
    const ws = workspacePath(slug);
    mkdirSync(join(ws, ".beads"), { recursive: true });
    writeFileSync(
      join(ws, ".beads", "metadata.json"),
      JSON.stringify({ dolt_mode: "server", dolt_database: dbName }, null, 2),
      "utf8",
    );
    const sharedDir = join(homeDir, ".beads", "shared-server", "dolt", dbName);
    mkdirSync(sharedDir, { recursive: true });
    return ws;
  };
  const seedOrphan = (slug: string, dbName: string, bytes = 1024): string => {
    const orphan = join(workspacePath(slug), ".beads", "embeddeddolt", dbName);
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, "data.bin"), Buffer.alloc(bytes, 0xab));
    return orphan;
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
    setupSharedServer,
    seedOrphan,
  };
}

describe("runRepoGc", () => {
  test("happy path, dry-run: would-sweep without removing the orphan, audit rows emitted", () => {
    const fx = withFixture([makeEntry("demo-repo", "/bare/ignored")]);
    fx.setupSharedServer("demo-repo", "demo_repo");
    const orphan = fx.seedOrphan("demo-repo", "demo_repo", 4096);

    const auditRows: { kind: string }[] = [];
    let rmCalls = 0;

    const report = runRepoGc(
      {
        config: fx.config,
        wtRoot: fx.wtRoot,
        apply: false,
        yes: false,
      },
      {
        homeDir: fx.homeDir,
        probeSharedServerHasIssues: () => true,
        rmSync: () => {
          rmCalls += 1;
        },
        appendAuditRow: (row) => auditRows.push(row as { kind: string }),
      },
    );

    expect(report.scanned).toBe(1);
    expect(report.orphansFound).toBe(1);
    expect(report.swept).toBe(0);
    expect(report.refused).toBe(0);
    expect(report.entries[0]!.action).toBe("would-sweep");
    expect(report.entries[0]!.orphanBytes).toBeGreaterThan(0);
    expect(rmCalls).toBe(0);
    expect(existsSync(orphan)).toBe(true);
    expect(auditRows.map((r) => r.kind)).toEqual(["repo-gc-entry", "repo-gc-run"]);
  });

  test("happy path, apply + yes: rmSync called, swept entry, cleanedBytes>0", () => {
    const fx = withFixture([makeEntry("demo-repo", "/bare/ignored")]);
    fx.setupSharedServer("demo-repo", "demo_repo");
    const orphan = fx.seedOrphan("demo-repo", "demo_repo", 2048);

    const rmCalls: string[] = [];
    const report = runRepoGc(
      {
        config: fx.config,
        wtRoot: fx.wtRoot,
        apply: true,
        yes: true,
      },
      {
        homeDir: fx.homeDir,
        probeSharedServerHasIssues: () => true,
        rmSync: (path) => {
          rmCalls.push(String(path));
          rmSync(String(path), { recursive: true, force: true });
        },
        appendAuditRow: () => {},
      },
    );

    expect(rmCalls).toEqual([orphan]);
    expect(existsSync(orphan)).toBe(false);
    expect(report.swept).toBe(1);
    expect(report.cleanedBytes).toBeGreaterThan(0);
    expect(report.entries[0]!.action).toBe("swept");
  });

  test("GC-I2 refusal: dolt_mode!='server' lands not-migrated, no mutation", () => {
    const fx = withFixture([makeEntry("alpha", "/bare/ignored")]);
    // Simulate a pre-migration workspace: embedded mode + orphan present.
    const ws = fx.workspacePath("alpha");
    mkdirSync(join(ws, ".beads"), { recursive: true });
    writeFileSync(
      join(ws, ".beads", "metadata.json"),
      JSON.stringify({ dolt_mode: "embedded", dolt_database: "alpha" }, null, 2),
      "utf8",
    );
    // Stand up the embeddeddolt orphan with the inner `.dolt` so the
    // classifier returns `embedded` (not `ambiguous`).
    const orphan = join(ws, ".beads", "embeddeddolt", "alpha");
    mkdirSync(join(orphan, ".dolt"), { recursive: true });

    let rmCalls = 0;
    const report = runRepoGc(
      {
        config: fx.config,
        wtRoot: fx.wtRoot,
        apply: true,
        yes: true,
      },
      {
        homeDir: fx.homeDir,
        probeSharedServerHasIssues: () => true,
        rmSync: () => {
          rmCalls += 1;
        },
        appendAuditRow: () => {},
      },
    );

    expect(rmCalls).toBe(0);
    expect(report.refused).toBe(1);
    expect(report.entries[0]!.action).toBe("refused");
    expect(report.entries[0]!.refusalReason).toBe("not-migrated");
  });

  test("GC-I3 refusal: server-unreachable when shared-server dolt root is absent", () => {
    const fx = withFixture([makeEntry("alpha", "/bare/ignored")]);
    // metadata.json says server-mode, but we do NOT create the shared-server
    // dolt root → classifyBeadsWorkspace falls through to one of the on-disk
    // arms; we still want the refusal path to fire on the missing root.
    const ws = fx.workspacePath("alpha");
    mkdirSync(join(ws, ".beads"), { recursive: true });
    writeFileSync(
      join(ws, ".beads", "metadata.json"),
      JSON.stringify({ dolt_mode: "server", dolt_database: "alpha" }, null, 2),
      "utf8",
    );
    fx.seedOrphan("alpha", "alpha", 512);
    // Also create the shared-server dolt root so the classifier returns
    // shared_server; then delete it before runRepoGc to simulate "configured
    // but unreachable on this run."
    const sharedDir = join(fx.homeDir, ".beads", "shared-server", "dolt", "alpha");
    mkdirSync(sharedDir, { recursive: true });

    // existsSync stub: return false for the shared-server dolt path so the
    // refusal fires deterministically without racing the classifier.
    const realExists = existsSync;
    const stubExists = (p: import("node:fs").PathLike): boolean => {
      if (String(p) === sharedDir) return false;
      return realExists(p);
    };

    const report = runRepoGc(
      {
        config: fx.config,
        wtRoot: fx.wtRoot,
        apply: false,
        yes: false,
      },
      {
        homeDir: fx.homeDir,
        existsSync: stubExists,
        probeSharedServerHasIssues: () => true,
        appendAuditRow: () => {},
      },
    );

    expect(report.refused).toBe(1);
    expect(report.entries[0]!.refusalReason).toBe("server-unreachable");
  });

  test("GC-I3 refusal: db-empty when probe returns false", () => {
    const fx = withFixture([makeEntry("alpha", "/bare/ignored")]);
    fx.setupSharedServer("alpha", "alpha");
    fx.seedOrphan("alpha", "alpha", 512);

    const report = runRepoGc(
      {
        config: fx.config,
        wtRoot: fx.wtRoot,
        apply: false,
        yes: false,
      },
      {
        homeDir: fx.homeDir,
        probeSharedServerHasIssues: () => false,
        appendAuditRow: () => {},
      },
    );

    expect(report.refused).toBe(1);
    expect(report.entries[0]!.refusalReason).toBe("db-empty");
  });

  test("GC-I5 idempotent: no embeddeddolt orphan present → nothing-to-clean", () => {
    const fx = withFixture([makeEntry("alpha", "/bare/ignored")]);
    fx.setupSharedServer("alpha", "alpha");
    // No seedOrphan call.

    const report = runRepoGc(
      {
        config: fx.config,
        wtRoot: fx.wtRoot,
        apply: true,
        yes: true,
      },
      {
        homeDir: fx.homeDir,
        probeSharedServerHasIssues: () => true,
        appendAuditRow: () => {},
      },
    );

    expect(report.orphansFound).toBe(0);
    expect(report.entries[0]!.action).toBe("nothing-to-clean");
  });

  test("slug narrowing: only the named slug is processed; unknown slug throws RepoGcError('no_such_slug')", () => {
    const fx = withFixture([makeEntry("alpha", "/bare/alpha"), makeEntry("beta", "/bare/beta")]);
    fx.setupSharedServer("alpha", "alpha");
    fx.setupSharedServer("beta", "beta");
    fx.seedOrphan("alpha", "alpha", 1024);
    fx.seedOrphan("beta", "beta", 1024);

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
        probeSharedServerHasIssues: () => true,
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
          probeSharedServerHasIssues: () => true,
          appendAuditRow: () => {},
        },
      ),
    ).toThrow(RepoGcError);
  });

  test("interactive --apply: promptConfirm=false suppresses rm; promptConfirm=true triggers rm", () => {
    const fx = withFixture([makeEntry("alpha", "/bare/alpha")]);
    fx.setupSharedServer("alpha", "alpha");
    fx.seedOrphan("alpha", "alpha", 512);

    let rmCalls = 0;
    const reportNo = runRepoGc(
      {
        config: fx.config,
        wtRoot: fx.wtRoot,
        apply: true,
        yes: false,
      },
      {
        homeDir: fx.homeDir,
        probeSharedServerHasIssues: () => true,
        promptConfirm: () => false,
        rmSync: () => {
          rmCalls += 1;
        },
        appendAuditRow: () => {},
      },
    );
    expect(rmCalls).toBe(0);
    expect(reportNo.swept).toBe(0);
    expect(reportNo.entries[0]!.action).toBe("would-sweep");

    const reportYes = runRepoGc(
      {
        config: fx.config,
        wtRoot: fx.wtRoot,
        apply: true,
        yes: false,
      },
      {
        homeDir: fx.homeDir,
        probeSharedServerHasIssues: () => true,
        promptConfirm: () => true,
        rmSync: () => {
          rmCalls += 1;
        },
        appendAuditRow: () => {},
      },
    );
    expect(rmCalls).toBe(1);
    expect(reportYes.swept).toBe(1);
    expect(reportYes.entries[0]!.action).toBe("swept");
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
          classification: "shared_server",
          orphanPath: "/wt/alpha.git/mainx/.beads/embeddeddolt/alpha",
          orphanBytes: 33_000_000,
          action: "would-sweep",
        },
        {
          slug: "beta",
          commonDir: "/bare/beta",
          workspacePath: "/wt/beta.git/mainx",
          classification: "shared_server",
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
