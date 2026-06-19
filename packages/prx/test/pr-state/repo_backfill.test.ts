import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import {
  formatRepoBackfill,
  kebabPrefixFromName,
  runRepoBackfill,
  type RepoBackfillReport,
} from "../../src/pr-state/repo_backfill.ts";
import type {
  LocalRepo,
  RepoInventory,
  RepoInventoryConfig,
  RepoRunner,
} from "../../src/pr-state/repos.ts";
import {
  RepoAddError,
  resolveDefaultBranch,
  verifyDefaultBranchRef,
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

function withTempInventory(repos: LocalRepo[]): {
  config: RepoInventoryConfig;
  wtRoot: string;
  indexPath: string;
  cleanup: () => string;
} {
  const root = mkdtempSync(join(tmpdir(), "prx-backfill-"));
  const repoRoot = join(root, "ai-home");
  const indexDir = join(repoRoot, ".prx", "repos");
  mkdirSync(indexDir, { recursive: true });
  const indexPath = join(indexDir, "index.json");
  const wtRoot = join(root, "wt");
  mkdirSync(wtRoot, { recursive: true });
  const inventory: RepoInventory = {
    roots: [],
    repos,
    bareRoot: join(root, "bare"),
    configPath: join(indexDir, "config.json"),
    indexPath,
    generatedAt: "2026-05-14T00:00:00.000Z",
  };
  writeRepoInventoryIndex(indexPath, inventory);
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
    indexPath,
    cleanup: () => root,
  };
}

describe("kebabPrefixFromName", () => {
  test("snake_case → kebab-case", () => {
    expect(kebabPrefixFromName("amz_sp_api")).toBe("amz-sp-api");
  });

  test("mixed punctuation collapses and trims", () => {
    expect(kebabPrefixFromName("My.Repo_Name__")).toBe("my-repo-name");
  });

  test("already-kebab passes through lowercased", () => {
    expect(kebabPrefixFromName("Demo-Web")).toBe("demo-web");
  });
});

describe("runRepoBackfill", () => {
  test("dry-run predicts name-derived prefixes with read-only subprocesses and no index write", () => {
    // GH-1736 loosens the previous zero-subprocess invariant to zero-mutation:
    // dry-run probes `origin/<default>` via `git rev-parse --verify` so the
    // forecast surfaces the same `default_branch_unresolved` failures the
    // apply pass would hit. Subprocesses are allowed, mutations are not.
    const tmp = mkdtempSync(join(tmpdir(), "prx-backfill-bare-"));
    const bareDir = join(tmp, "bare", "io.github", "owner", "imdb-kaggle.git");
    mkdirSync(bareDir, { recursive: true });
    const { config, wtRoot, indexPath } = withTempInventory([makeEntry("imdb-kaggle", bareDir)]);
    const indexBefore = readFileSync(indexPath, "utf8");
    const auditRows: unknown[] = [];

    const runnerCalls: string[] = [];
    const runner: RepoRunner = (cmd) => {
      runnerCalls.push(cmd.join(" "));
      return { stdout: "", stderr: "", status: 0 };
    };

    const report = runRepoBackfill(
      { config, wtRoot, dryRun: true, dolthubOwner: null },
      {
        runner,
        appendAuditRow: (row) => auditRows.push(row),
      },
    );

    // No mutating git subcommands fire in dry-run.
    for (const call of runnerCalls) {
      expect(call).not.toContain("worktree add");
      expect(call).not.toContain("git fetch");
      expect(call).not.toContain("bd config");
    }
    expect(report.scanned).toBe(1);
    expect(report.populated).toBe(1);
    expect(report.bdMissing).toBe(1);
    expect(report.entries[0]).toMatchObject({
      slug: "imdb-kaggle",
      action: "set",
      source: "name-derived",
      bdWorkspacePrefix: "imdb-kaggle",
    });
    expect(readFileSync(indexPath, "utf8")).toBe(indexBefore);
    expect(auditRows.length).toBe(2);
    expect((auditRows[0] as { kind: string }).kind).toBe("repo-backfill-entry");
    expect((auditRows[1] as { kind: string }).kind).toBe("repo-backfill-run");
    expect((auditRows[1] as { dryRun: boolean }).dryRun).toBe(true);
  });

  test("apply pass reads bd config when hydration succeeds, falls back to kebab otherwise", () => {
    const tmp = mkdtempSync(join(tmpdir(), "prx-backfill-apply-"));
    const bareA = join(tmp, "bare", "owner", "ai-home.git");
    const bareB = join(tmp, "bare", "owner", "imdb-kaggle.git");
    mkdirSync(bareA, { recursive: true });
    mkdirSync(bareB, { recursive: true });
    const { config, wtRoot, indexPath } = withTempInventory([
      makeEntry("ai-home", bareA),
      makeEntry("imdb-kaggle", bareB),
    ]);
    const auditRows: { kind: string; [k: string]: unknown }[] = [];

    const runner: RepoRunner = () => ({ stdout: "main\n", stderr: "", status: 0 });
    let bdCallCount = 0;
    const report = runRepoBackfill(
      { config, wtRoot, dryRun: false, dolthubOwner: null },
      {
        runner,
        materializeMainxIfMissing: () => ({ defaultBranch: "main", created: true }),
        hydrateAfterMaterialize: () => ({
          status: "hydrated",
          doltRemote: null,
          doltDatabase: "ai_home",
          message: "ok",
          exitCode: 0,
        }),
        readBdWorkspacePrefix: () => {
          bdCallCount += 1;
          if (bdCallCount === 1) return "ai-home";
          throw new RepoAddError("no bd config", "bd_workspace_prefix_unresolved");
        },
        appendAuditRow: (row) => auditRows.push(row as { kind: string }),
      },
    );

    expect(report.populated).toBe(2);
    expect(report.bdMissing).toBe(1);
    expect(report.failed).toBe(0);
    const inventoryAfter = JSON.parse(readFileSync(indexPath, "utf8")) as RepoInventory;
    expect(inventoryAfter.repos[0]!.bd_workspace_prefix).toBe("ai-home");
    expect(inventoryAfter.repos[1]!.bd_workspace_prefix).toBe("imdb-kaggle");

    const entryRows = auditRows.filter((r) => r.kind === "repo-backfill-entry");
    const runRows = auditRows.filter((r) => r.kind === "repo-backfill-run");
    expect(entryRows.length).toBe(2);
    expect(runRows.length).toBe(1);
    expect(auditRows[auditRows.length - 1]!.kind).toBe("repo-backfill-run");
    expect(entryRows[0]).toMatchObject({ source: "bd-config", action: "set" });
    expect(entryRows[1]).toMatchObject({
      source: "name-derived",
      action: "set",
      bdWorkspacePrefix: "imdb-kaggle",
    });
  });

  test("idempotent re-run: alreadySet counts the populated entries and no write happens", () => {
    const tmp = mkdtempSync(join(tmpdir(), "prx-backfill-idem-"));
    const bare = join(tmp, "bare", "owner", "demo-web.git");
    mkdirSync(bare, { recursive: true });
    const { config, wtRoot, indexPath } = withTempInventory([
      makeEntry("demo-web", bare, { bd_workspace_prefix: "demo-web" }),
    ]);
    const indexBefore = readFileSync(indexPath, "utf8");

    let materializeCalls = 0;
    const report = runRepoBackfill(
      { config, wtRoot, dryRun: false, dolthubOwner: null },
      {
        runner: () => ({ stdout: "", stderr: "", status: 0 }),
        materializeMainxIfMissing: () => {
          materializeCalls += 1;
          return { defaultBranch: "main", created: true };
        },
        appendAuditRow: () => {},
      },
    );

    expect(materializeCalls).toBe(0);
    expect(report.alreadySet).toBe(1);
    expect(report.populated).toBe(0);
    expect(report.failed).toBe(0);
    expect(readFileSync(indexPath, "utf8")).toBe(indexBefore);
  });

  test("skips entries whose primary remote is local-only (file://, no githubRepo)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "prx-backfill-fileonly-"));
    const bare = join(tmp, "bare", "dx-compose.git");
    mkdirSync(bare, { recursive: true });
    const { config, wtRoot } = withTempInventory([
      makeEntry("dx-compose", bare, {
        primaryRemote: {
          name: "origin",
          url: "file:///some/local/path",
          githubRepo: null,
        },
      }),
    ]);

    const report = runRepoBackfill(
      { config, wtRoot, dryRun: false, dolthubOwner: null },
      { runner: () => ({ stdout: "", stderr: "", status: 0 }), appendAuditRow: () => {} },
    );
    expect(report.skipped).toBe(1);
    expect(report.entries[0]).toMatchObject({ action: "skipped", reason: "local_only_repo" });
  });

  test("skips entries whose commonDir does not exist", () => {
    const tmp = mkdtempSync(join(tmpdir(), "prx-backfill-missing-"));
    const missing = join(tmp, "does", "not", "exist.git");
    const { config, wtRoot } = withTempInventory([makeEntry("ghost", missing)]);

    const report = runRepoBackfill(
      { config, wtRoot, dryRun: false, dolthubOwner: null },
      { runner: () => ({ stdout: "", stderr: "", status: 0 }), appendAuditRow: () => {} },
    );
    expect(report.skipped).toBe(1);
    expect(report.entries[0]!.reason).toBe("commondir_missing");
  });

  test("kebab collision lands as failed with a precise reason", () => {
    const tmp = mkdtempSync(join(tmpdir(), "prx-backfill-collision-"));
    const bareA = join(tmp, "bare", "amz-sp-api.git");
    const bareB = join(tmp, "bare", "amz_sp_api.git");
    mkdirSync(bareA, { recursive: true });
    mkdirSync(bareB, { recursive: true });
    const { config, wtRoot } = withTempInventory([
      makeEntry("amz-sp-api", bareA, { bd_workspace_prefix: "amz-sp-api" }),
      makeEntry("amz_sp_api", bareB),
    ]);

    const report = runRepoBackfill(
      { config, wtRoot, dryRun: false, dolthubOwner: null },
      {
        runner: () => ({ stdout: "", stderr: "", status: 0 }),
        materializeMainxIfMissing: () => ({ defaultBranch: "main", created: true }),
        hydrateAfterMaterialize: () => ({
          status: "skipped-no-beads",
          doltRemote: null,
          doltDatabase: null,
          message: "no .beads in HEAD",
          exitCode: 0,
        }),
        readBdWorkspacePrefix: () => {
          throw new RepoAddError("no bd", "bd_workspace_prefix_unresolved");
        },
        appendAuditRow: () => {},
      },
    );

    expect(report.alreadySet).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.entries[1]!.action).toBe("failed");
    expect(report.entries[1]!.reason).toContain("prefix_collision");
  });

  test("default-branch-unresolved is isolated per entry — sibling entry still gets processed", () => {
    const tmp = mkdtempSync(join(tmpdir(), "prx-backfill-isolation-"));
    const bareA = join(tmp, "bare", "broken.git");
    const bareB = join(tmp, "bare", "healthy.git");
    mkdirSync(bareA, { recursive: true });
    mkdirSync(bareB, { recursive: true });
    const { config, wtRoot, indexPath } = withTempInventory([
      makeEntry("broken", bareA),
      makeEntry("healthy", bareB),
    ]);

    const materialize = (barePath: string) => {
      if (barePath === bareA) {
        throw new RepoAddError("no default branch", "default_branch_unresolved");
      }
      return { defaultBranch: "main", created: true };
    };

    const report = runRepoBackfill(
      { config, wtRoot, dryRun: false, dolthubOwner: null },
      {
        runner: () => ({ stdout: "", stderr: "", status: 0 }),
        materializeMainxIfMissing: materialize,
        hydrateAfterMaterialize: () => ({
          status: "skipped-no-beads",
          doltRemote: null,
          doltDatabase: null,
          message: "no .beads",
          exitCode: 0,
        }),
        readBdWorkspacePrefix: () => {
          throw new RepoAddError("no bd", "bd_workspace_prefix_unresolved");
        },
        appendAuditRow: () => {},
      },
    );

    expect(report.failed).toBe(1);
    expect(report.populated).toBe(1);
    expect(report.entries[0]).toMatchObject({ slug: "broken", action: "failed" });
    // GH-1736: failing audit `reason` is the normalized code; the raw stderr
    // / Error message is preserved as a sibling `detail` field.
    expect(report.entries[0]!.reason).toBe("default_branch_unresolved");
    expect(report.entries[0]!.detail).toBe("no default branch");
    expect(report.entries[1]).toMatchObject({
      slug: "healthy",
      action: "set",
      source: "name-derived",
      bdWorkspacePrefix: "healthy",
    });
    const written = JSON.parse(readFileSync(indexPath, "utf8")) as RepoInventory;
    expect(written.repos[0]!.bd_workspace_prefix).toBeUndefined();
    expect(written.repos[1]!.bd_workspace_prefix).toBe("healthy");
  });

  test("audit row ordering: one entry row per scanned repo, run row last", () => {
    const tmp = mkdtempSync(join(tmpdir(), "prx-backfill-audit-"));
    const bareA = join(tmp, "bare", "alpha.git");
    const bareB = join(tmp, "bare", "beta.git");
    mkdirSync(bareA, { recursive: true });
    mkdirSync(bareB, { recursive: true });
    const { config, wtRoot } = withTempInventory([
      makeEntry("alpha", bareA),
      makeEntry("beta", bareB, { bd_workspace_prefix: "beta" }),
    ]);
    const auditRows: { kind: string }[] = [];

    runRepoBackfill(
      { config, wtRoot, dryRun: true, dolthubOwner: null },
      {
        runner: () => ({ stdout: "", stderr: "", status: 0 }),
        appendAuditRow: (row) => auditRows.push(row as { kind: string }),
      },
    );

    expect(auditRows.map((r) => r.kind)).toEqual([
      "repo-backfill-entry",
      "repo-backfill-entry",
      "repo-backfill-run",
    ]);
  });

  test("dry-run probes default-branch ref existence and reports failed entry without writing the index", () => {
    // GH-1736 defect-A: dry-run forecast must observe the same
    // `default_branch_unresolved` failures the apply path would hit, so
    // operators can use dry-run as a real safety check. The probe is
    // `git rev-parse --verify origin/<default>` — read-only, no mutation.
    const tmp = mkdtempSync(join(tmpdir(), "prx-backfill-dryprobe-"));
    const bareA = join(tmp, "bare", "broken.git");
    const bareB = join(tmp, "bare", "healthy.git");
    mkdirSync(bareA, { recursive: true });
    mkdirSync(bareB, { recursive: true });
    const { config, wtRoot, indexPath } = withTempInventory([
      makeEntry("broken", bareA),
      makeEntry("healthy", bareB),
    ]);
    const indexBefore = readFileSync(indexPath, "utf8");

    const runner: RepoRunner = (cmd) => {
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes("symbolic-ref")) {
        return { stdout: "origin/main\n", stderr: "", status: 0 };
      }
      if (cmdStr.includes("rev-parse --verify origin/main")) {
        if (cmd.includes(bareA)) {
          return {
            stdout: "",
            stderr: "fatal: invalid reference: origin/main\n",
            status: 128,
          };
        }
        return { stdout: "abc123\n", stderr: "", status: 0 };
      }
      return { stdout: "", stderr: "", status: 0 };
    };

    const report = runRepoBackfill(
      { config, wtRoot, dryRun: true, dolthubOwner: null },
      { runner, appendAuditRow: () => {} },
    );

    expect(report.failed).toBe(1);
    expect(report.populated).toBe(1);
    expect(report.entries[0]).toMatchObject({
      slug: "broken",
      action: "failed",
      reason: "default_branch_unresolved",
      detail: "fatal: invalid reference: origin/main",
    });
    expect(report.entries[1]).toMatchObject({
      slug: "healthy",
      action: "set",
      source: "name-derived",
    });
    // Dry-run still must not mutate the index — the new probe is read-only.
    expect(readFileSync(indexPath, "utf8")).toBe(indexBefore);
  });

  test("forecast/apply parity: dry-run failure counts match apply over the same inventory", () => {
    // GH-1736 AC: `failed_count_dryrun == failed_count_apply` over the same
    // inventory. Same runner stub fails one entry's rev-parse probe and
    // succeeds for the other; apply stubs `materializeMainxIfMissing` to
    // delegate through to the real `resolveDefaultBranch` +
    // `verifyDefaultBranchRef` against the same runner.
    const tmp = mkdtempSync(join(tmpdir(), "prx-backfill-parity-"));
    const bareA = join(tmp, "bare", "broken.git");
    const bareB = join(tmp, "bare", "healthy.git");
    mkdirSync(bareA, { recursive: true });
    mkdirSync(bareB, { recursive: true });

    const buildRunner = (): RepoRunner => (cmd) => {
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes("symbolic-ref")) {
        return { stdout: "origin/main\n", stderr: "", status: 0 };
      }
      if (cmdStr.includes("rev-parse --verify origin/main")) {
        if (cmd.includes(bareA)) {
          return {
            stdout: "",
            stderr: "fatal: invalid reference: origin/main\n",
            status: 128,
          };
        }
        return { stdout: "abc123\n", stderr: "", status: 0 };
      }
      return { stdout: "", stderr: "", status: 0 };
    };

    const forecastFixture = withTempInventory([
      makeEntry("broken", bareA),
      makeEntry("healthy", bareB),
    ]);
    const forecast = runRepoBackfill(
      {
        config: forecastFixture.config,
        wtRoot: forecastFixture.wtRoot,
        dryRun: true,
        dolthubOwner: null,
      },
      { runner: buildRunner(), appendAuditRow: () => {} },
    );

    const applyFixture = withTempInventory([
      makeEntry("broken", bareA),
      makeEntry("healthy", bareB),
    ]);
    const apply = runRepoBackfill(
      {
        config: applyFixture.config,
        wtRoot: applyFixture.wtRoot,
        dryRun: false,
        dolthubOwner: null,
      },
      {
        runner: buildRunner(),
        materializeMainxIfMissing: (barePath, _mainxPath, runner) => {
          const branch = resolveDefaultBranch(barePath, runner);
          verifyDefaultBranchRef(barePath, branch, runner);
          return { defaultBranch: branch, created: true };
        },
        hydrateAfterMaterialize: () => ({
          status: "skipped-no-beads",
          doltRemote: null,
          doltDatabase: null,
          message: "no .beads",
          exitCode: 0,
        }),
        readBdWorkspacePrefix: () => {
          throw new RepoAddError("no bd", "bd_workspace_prefix_unresolved");
        },
        appendAuditRow: () => {},
      },
    );

    expect(forecast.failed).toBe(apply.failed);
    expect(forecast.populated).toBe(apply.populated);
    expect(apply.failed).toBe(1);
    expect(apply.populated).toBe(1);
    expect(apply.entries[0]!.reason).toBe("default_branch_unresolved");
    expect(apply.entries[0]!.detail).toBe("fatal: invalid reference: origin/main");
  });

  test("formatRepoBackfill includes bootstrap hint + dolt-remote for name-derived entries", () => {
    const report: RepoBackfillReport = {
      dryRun: true,
      scanned: 1,
      populated: 1,
      alreadySet: 0,
      skipped: 0,
      failed: 0,
      bdMissing: 1,
      durationMs: 1,
      entries: [
        {
          slug: "imdb-kaggle",
          commonDir: "/tmp/imdb-kaggle.git",
          action: "set",
          source: "name-derived",
          bdWorkspacePrefix: "imdb-kaggle",
          materializedMainx: false,
          hydrated: false,
          doltRemote: "https://doltremoteapi.dolthub.com/owner/imdb-kaggle",
        },
      ],
    };
    const out = formatRepoBackfill(report, "plain");
    expect(out).toContain("prx repo refresh imdb-kaggle");
    expect(out).toContain("dolt-remote: https://doltremoteapi.dolthub.com");
    expect(out).toContain("bdMissing=1");
    expect(out).toContain("(dry-run)");

    const json = formatRepoBackfill(report, "json");
    expect(JSON.parse(json)).toMatchObject({ populated: 1, bdMissing: 1 });
  });
});
