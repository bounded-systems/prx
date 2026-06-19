// GH-1701 — `prx repo audit` projection + formatter. Pure-unit tests against
// injected fakes; no shell-outs or fs reads.

import { describe, expect, test } from "bun:test";

import type { BeadsWorkspaceMode } from "../../src/beads/workspace_mode.ts";
import type { LocalRepo, RepoInventory } from "../../src/pr-state/repos.ts";
import {
  auditRegisteredRepos,
  formatRepoAudit,
  repoAuditReportSchema,
  type RepoAuditDeps,
  type RepoAuditRow,
} from "../../src/pr-state/repo_audit.ts";

function makeRepo(overrides: Partial<LocalRepo> = {}): LocalRepo {
  return {
    name: overrides.name ?? "demo",
    commonDir: overrides.commonDir ?? "/repos/demo/.git",
    kind: overrides.kind ?? "bare",
    mainWorktree: overrides.mainWorktree ?? null,
    worktrees: overrides.worktrees ?? [],
    localOnlyBranches: overrides.localOnlyBranches ?? [],
    findings: overrides.findings ?? [],
    remotes: overrides.remotes ?? [],
    primaryRemote: overrides.primaryRemote ?? null,
    upstreamRemote: overrides.upstreamRemote ?? null,
    bd_workspace_prefix: overrides.bd_workspace_prefix,
    dolt_remote: overrides.dolt_remote,
  };
}

function makeInventory(repos: LocalRepo[]): RepoInventory {
  return { roots: [], repos };
}

function makeDeps(overrides: Partial<RepoAuditDeps> = {}): RepoAuditDeps {
  return {
    classify: overrides.classify ?? (() => ({ kind: "none" })),
    getGitOrigin: overrides.getGitOrigin ?? (() => null),
    countIssues: overrides.countIssues ?? (() => null),
    dolthubOwner: overrides.dolthubOwner ?? null,
  };
}

describe("auditRegisteredRepos: beads_state derivation", () => {
  const cases: Array<{
    name: string;
    mode: BeadsWorkspaceMode;
    expected: RepoAuditRow["beads_state"];
  }> = [
    { name: "none", mode: { kind: "none" }, expected: "none" },
    {
      name: "embedded",
      mode: { kind: "embedded", doltDir: "/x/.dolt" },
      expected: "embedded",
    },
    {
      name: "per_project",
      mode: { kind: "per_project", doltDir: "/x/dolt" },
      expected: "per-project",
    },
    {
      name: "shared_server",
      mode: { kind: "shared_server", sharedDir: "/x/shared/dolt/db" },
      expected: "shared-server",
    },
    {
      name: "ambiguous",
      mode: { kind: "ambiguous", details: "x" },
      expected: "ambiguous",
    },
  ];

  for (const c of cases) {
    test(`${c.name} → beads_state=${c.expected}`, () => {
      const rows = auditRegisteredRepos(
        makeInventory([makeRepo()]),
        makeDeps({ classify: () => c.mode }),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.beads_state).toBe(c.expected);
    });
  }
});

describe("auditRegisteredRepos: migration_candidate mapping (GH-1701)", () => {
  test("none → bootstrap", () => {
    const rows = auditRegisteredRepos(
      makeInventory([makeRepo()]),
      makeDeps({ classify: () => ({ kind: "none" }) }),
    );
    expect(rows[0]!.migration_candidate).toBe("bootstrap");
  });

  test("embedded → migrate", () => {
    const rows = auditRegisteredRepos(
      makeInventory([makeRepo()]),
      makeDeps({
        classify: () => ({ kind: "embedded", doltDir: "/x/.dolt" }),
      }),
    );
    expect(rows[0]!.migration_candidate).toBe("migrate");
  });

  test("per_project without dolt_remote → add-dolthub", () => {
    const rows = auditRegisteredRepos(
      makeInventory([makeRepo()]),
      makeDeps({
        classify: () => ({ kind: "per_project", doltDir: "/x/dolt" }),
        getGitOrigin: () => null,
      }),
    );
    expect(rows[0]!.dolt_remote).toBeNull();
    expect(rows[0]!.migration_candidate).toBe("add-dolthub");
  });

  test("per_project with derived dolt_remote but no persisted one → add-dolthub (GH-1703)", () => {
    // GH-1703 inverts the previous semantics: the `migration_candidate`
    // signal is "is this repo *wired*", which is the persisted
    // `repo.dolt_remote`, not the derived URL the audit can always recover
    // from origin. So a per-project repo whose origin parses cleanly still
    // surfaces as `add-dolthub` until the operator runs the wire verb.
    const rows = auditRegisteredRepos(
      makeInventory([makeRepo()]),
      makeDeps({
        classify: () => ({ kind: "per_project", doltDir: "/x/dolt" }),
        getGitOrigin: () => "git@github.com:bdelanghe/ai-home.git",
        dolthubOwner: "bdelanghe",
      }),
    );
    expect(rows[0]!.dolt_remote).toBe("https://doltremoteapi.dolthub.com/bdelanghe/ai-home");
    expect(rows[0]!.migration_candidate).toBe("add-dolthub");
  });

  test("per_project with persisted dolt_remote → none, persisted wins over derived (GH-1703)", () => {
    const rows = auditRegisteredRepos(
      makeInventory([
        makeRepo({
          dolt_remote: "https://doltremoteapi.dolthub.com/bdelanghe/custom-name",
        }),
      ]),
      makeDeps({
        classify: () => ({ kind: "per_project", doltDir: "/x/dolt" }),
        getGitOrigin: () => "git@github.com:bdelanghe/ai-home.git",
        dolthubOwner: "bdelanghe",
      }),
    );
    expect(rows[0]!.dolt_remote).toBe("https://doltremoteapi.dolthub.com/bdelanghe/custom-name");
    expect(rows[0]!.migration_candidate).toBe("none");
  });

  test("shared_server → none", () => {
    const rows = auditRegisteredRepos(
      makeInventory([makeRepo()]),
      makeDeps({
        classify: () => ({ kind: "shared_server", sharedDir: "/x/shared" }),
      }),
    );
    expect(rows[0]!.migration_candidate).toBe("none");
  });

  test("ambiguous → repair", () => {
    const rows = auditRegisteredRepos(
      makeInventory([makeRepo()]),
      makeDeps({
        classify: () => ({ kind: "ambiguous", details: "x" }),
      }),
    );
    expect(rows[0]!.migration_candidate).toBe("repair");
  });
});

describe("auditRegisteredRepos: issue_count semantics", () => {
  test("issue_count=unknown when beads_state=none (I-RA2: never probes bd)", () => {
    let probed = false;
    const rows = auditRegisteredRepos(
      makeInventory([makeRepo()]),
      makeDeps({
        classify: () => ({ kind: "none" }),
        countIssues: () => {
          probed = true;
          return 42;
        },
      }),
    );
    expect(rows[0]!.issue_count).toBe("unknown");
    expect(probed).toBe(false);
  });

  test("issue_count=unknown when beads_state=ambiguous (I-RA2: skip probe)", () => {
    let probed = false;
    const rows = auditRegisteredRepos(
      makeInventory([makeRepo()]),
      makeDeps({
        classify: () => ({ kind: "ambiguous", details: "x" }),
        countIssues: () => {
          probed = true;
          return 42;
        },
      }),
    );
    expect(rows[0]!.issue_count).toBe("unknown");
    expect(probed).toBe(false);
  });

  test("issue_count surfaces probe value when bd list succeeds", () => {
    const rows = auditRegisteredRepos(
      makeInventory([makeRepo()]),
      makeDeps({
        classify: () => ({ kind: "per_project", doltDir: "/x/dolt" }),
        countIssues: () => 412,
      }),
    );
    expect(rows[0]!.issue_count).toBe(412);
  });

  test("issue_count=unknown when probe returns null (bd list failed)", () => {
    const rows = auditRegisteredRepos(
      makeInventory([makeRepo()]),
      makeDeps({
        classify: () => ({ kind: "per_project", doltDir: "/x/dolt" }),
        countIssues: () => null,
      }),
    );
    expect(rows[0]!.issue_count).toBe("unknown");
  });
});

describe("auditRegisteredRepos: bd_workspace_prefix coalescing (GH-1657)", () => {
  test("undefined prefix → null in the row", () => {
    const rows = auditRegisteredRepos(
      makeInventory([makeRepo({ bd_workspace_prefix: undefined })]),
      makeDeps(),
    );
    expect(rows[0]!.bd_workspace_prefix).toBeNull();
  });

  test("set prefix passes through", () => {
    const rows = auditRegisteredRepos(
      makeInventory([makeRepo({ bd_workspace_prefix: "demo" })]),
      makeDeps(),
    );
    expect(rows[0]!.bd_workspace_prefix).toBe("demo");
  });
});

describe("auditRegisteredRepos: order and shape", () => {
  test("one row per inventory entry, in input order", () => {
    const inventory = makeInventory([
      makeRepo({ name: "alpha", commonDir: "/a" }),
      makeRepo({ name: "beta", commonDir: "/b" }),
      makeRepo({ name: "gamma", commonDir: "/c" }),
    ]);
    const rows = auditRegisteredRepos(inventory, makeDeps());
    expect(rows.map((r) => r.name)).toEqual(["alpha", "beta", "gamma"]);
    expect(rows.map((r) => r.commonDir)).toEqual(["/a", "/b", "/c"]);
  });
});

describe("formatRepoAudit", () => {
  const rows: RepoAuditRow[] = [
    {
      name: "alpha",
      bd_workspace_prefix: "alp",
      commonDir: "/a",
      beads_state: "per-project",
      dolt_remote: "https://doltremoteapi.dolthub.com/bd/x__bd__alpha",
      issue_count: 12,
      migration_candidate: "none",
    },
    {
      name: "beta",
      bd_workspace_prefix: null,
      commonDir: "/b",
      beads_state: "embedded",
      dolt_remote: null,
      issue_count: "unknown",
      migration_candidate: "migrate",
    },
  ];

  test("json: schema-validated round-trip with wrapper", () => {
    const out = formatRepoAudit(rows, "json", "2026-05-14T00:00:00Z");
    const parsed = JSON.parse(out);
    expect(repoAuditReportSchema.parse(parsed)).toEqual(parsed);
    expect(parsed.generatedAt).toBe("2026-05-14T00:00:00Z");
    expect(parsed.repos).toHaveLength(2);
    expect(parsed.repos[0].name).toBe("alpha");
  });

  test("plain: includes header, generated-at, and per-row block", () => {
    const out = formatRepoAudit(rows, "plain", "2026-05-14T00:00:00Z");
    expect(out).toContain("Repo audit (2 repos)");
    expect(out).toContain("Generated: 2026-05-14T00:00:00Z");
    expect(out).toContain("alpha [prefix=alp]");
    expect(out).toContain("beta [prefix=none]");
    expect(out).toContain("state: per-project");
    expect(out).toContain("state: embedded");
    expect(out).toContain("remote: (none)");
    expect(out).toContain("issues: 12");
    expect(out).toContain("issues: unknown");
    expect(out).toContain("migration: migrate");
  });

  test("plain: empty inventory renders explicit empty message", () => {
    const out = formatRepoAudit([], "plain", "2026-05-14T00:00:00Z");
    expect(out).toContain("Repo audit (0 repos)");
    expect(out).toContain("No repos registered");
  });

  test("plain: singular pluralization for one repo", () => {
    const out = formatRepoAudit([rows[0]!], "plain", "2026-05-14T00:00:00Z");
    expect(out).toContain("Repo audit (1 repo)");
  });
});
