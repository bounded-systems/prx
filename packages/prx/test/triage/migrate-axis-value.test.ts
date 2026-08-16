import { describe, expect, test } from "bun:test";

import {
  buildMigratePlan,
  runTriageMigrateAxisValue,
  selectMigrateDecision,
  triageMigrateAxisValueOptionsSchema,
  type MigratePlan,
} from "../../src/triage/migrate-axis-value.ts";
import type { GhExecResult } from "@bounded-systems/gh";
import type { FallbackIssue } from "../../src/pr-state/github.ts";
import { makeRunBeadsSyncMock } from "./sync-mock.ts";

function ghLabel(name: string): { name: string } {
  return { name };
}

function issue(overrides: Partial<FallbackIssue> = {}): FallbackIssue {
  return {
    number: 100,
    title: "feat: x",
    url: "https://github.com/bdelanghe/ai-home/issues/100",
    labels: [],
    ...overrides,
  };
}

function makeOutput() {
  const log: string[] = [];
  const error: string[] = [];
  return {
    output: { log: (line: string) => log.push(line), error: (line: string) => error.push(line) },
    log,
    error,
  };
}

const NOW = new Date("2026-04-29T00:00:00.000Z");
const STD_DEPS_BASE = {
  now: () => NOW,
  cwd: () => "/tmp/repo",
  repoNameWithOwner: () => "bdelanghe/ai-home",
  auditSink: {
    stateDirOverride: "/tmp/state",
    ensureDir: () => {},
  },
};

describe("triageMigrateAxisValueOptionsSchema", () => {
  test("accepts valid type axis migration", () => {
    const parsed = triageMigrateAxisValueOptionsSchema.parse({
      axis: "type",
      from: "refactor",
      to: "chore",
    });
    expect(parsed.apply).toBe(false);
    expect(parsed.sync).toBe(true);
    expect(parsed.limit).toBe(0);
  });

  test("rejects --from === --to", () => {
    const result = triageMigrateAxisValueOptionsSchema.safeParse({
      axis: "type",
      from: "chore",
      to: "chore",
    });
    expect(result.success).toBe(false);
  });

  test("rejects --to outside the axis enum", () => {
    const result = triageMigrateAxisValueOptionsSchema.safeParse({
      axis: "type",
      from: "refactor",
      to: "not-a-real-type",
    });
    expect(result.success).toBe(false);
  });

  test("accepts arbitrary --from string (out-of-vocab is the point)", () => {
    const parsed = triageMigrateAxisValueOptionsSchema.parse({
      axis: "type",
      from: "spike",
      to: "task",
    });
    expect(parsed.from).toBe("spike");
  });

  test("rejects invalid --axis", () => {
    const result = triageMigrateAxisValueOptionsSchema.safeParse({
      axis: "color",
      from: "x",
      to: "y",
    });
    expect(result.success).toBe(false);
  });
});

describe("selectMigrateDecision", () => {
  test("emits migrate row when issue carries the from-label", () => {
    const row = selectMigrateDecision(
      issue({ number: 5, labels: [ghLabel("type::refactor"), ghLabel("priority::low")] }),
      "type",
      "refactor",
      "chore",
    );
    expect(row).not.toBeNull();
    expect(row!.decision).toBe("migrate");
    expect(row!.fromLabel).toBe("type::refactor");
    expect(row!.toLabel).toBe("type::chore");
    expect(row!.reason).toMatch(/swapping/);
  });

  test("returns null when issue does not carry from-label", () => {
    const row = selectMigrateDecision(
      issue({ labels: [ghLabel("type::chore"), ghLabel("priority::low")] }),
      "type",
      "refactor",
      "chore",
    );
    expect(row).toBeNull();
  });

  test("returns null when issue has no labels", () => {
    const row = selectMigrateDecision(issue({ labels: [] }), "type", "refactor", "chore");
    expect(row).toBeNull();
  });

  test("emits migrate row even when issue already has the to-label (mid-migration cleanup)", () => {
    const row = selectMigrateDecision(
      issue({ labels: [ghLabel("type::refactor"), ghLabel("type::chore")] }),
      "type",
      "refactor",
      "chore",
    );
    expect(row).not.toBeNull();
    expect(row!.decision).toBe("migrate");
    expect(row!.reason).toMatch(/both/);
  });

  test("ignores other axes", () => {
    const row = selectMigrateDecision(
      issue({ labels: [ghLabel("priority::refactor")] }),
      "type",
      "refactor",
      "chore",
    );
    expect(row).toBeNull();
  });
});

describe("buildMigratePlan", () => {
  test("filters down to issues that carry the from-label", () => {
    const issues = [
      issue({ number: 1, labels: [ghLabel("type::refactor")] }),
      issue({ number: 2, labels: [ghLabel("type::chore")] }),
      issue({ number: 3, labels: [ghLabel("type::refactor"), ghLabel("priority::high")] }),
      issue({ number: 4, labels: [] }),
    ];
    const plan = buildMigratePlan(
      issues,
      "bdelanghe/ai-home",
      "type",
      "refactor",
      "chore",
      NOW.toISOString(),
    );
    expect(plan.rows.map((r) => r.number)).toEqual([1, 3]);
    expect(plan.repo).toBe("bdelanghe/ai-home");
    expect(plan.axis).toBe("type");
    expect(plan.from).toBe("refactor");
    expect(plan.to).toBe("chore");
  });
});

describe("runTriageMigrateAxisValue — dry-run (no --apply)", () => {
  test("emits JSON plan to stdout, makes no gh calls", async () => {
    let ghCalls = 0;
    const o = makeOutput();
    const code = await runTriageMigrateAxisValue(
      { axis: "type", from: "refactor", to: "chore", apply: false, limit: 0, sync: true },
      o.output,
      {
        ...STD_DEPS_BASE,
        listOpenIssues: () => [
          issue({ number: 1, labels: [ghLabel("type::refactor")] }),
          issue({ number: 2, labels: [ghLabel("type::chore")] }),
        ],
        execGh: () => {
          ghCalls += 1;
          return { exitCode: 0, stdout: "", stderr: "", policy: null };
        },
        auditSink: {
          stateDirOverride: "/tmp/state",
          ensureDir: () => {},
          appendFn: () => {},
        },
      },
    );
    expect(code).toBe(0);
    expect(ghCalls).toBe(0);
    expect(o.log).toHaveLength(1);
    const plan = JSON.parse(o.log[0]!) as MigratePlan;
    expect(plan.rows.map((r) => r.number)).toEqual([1]);
  });
});

describe("runTriageMigrateAxisValue — apply path", () => {
  function setup(options: {
    issues: FallbackIssue[];
    ghResults?: GhExecResult[];
    syncResult?: { exitCode: number; stdout: string; stderr: string };
  }) {
    const audit: string[] = [];
    let ghIndex = 0;
    const ghResults = options.ghResults ?? [];
    const ghCalls: Array<{ subcommand: string; args: string[] }> = [];
    const execGh = (opts: { subcommand: string; args: string[] }) => {
      ghCalls.push({ subcommand: opts.subcommand, args: opts.args });
      const result = ghResults[ghIndex] ?? {
        exitCode: 0,
        stdout: "",
        stderr: "",
        policy: null,
      };
      ghIndex += 1;
      return result;
    };
    let syncCalls = 0;
    // GH-2316: the post-write reconcile now routes through the status-only
    // `runBeadsSync` (canonical reconcile) instead of the retired destructive
    // `bd github sync --pull-only --prefer-github` shell-out. The seam returns
    // a Promise<BeadsSyncResult> and streams stdout/stderr to the output sink.
    const runBeadsSync = makeRunBeadsSyncMock(
      options.syncResult ?? { exitCode: 0, stdout: "ok", stderr: "" },
      () => {
        syncCalls += 1;
      },
    );
    const o = makeOutput();
    const deps = {
      ...STD_DEPS_BASE,
      listOpenIssues: () => options.issues,
      execGh,
      auditSink: {
        ...STD_DEPS_BASE.auditSink,
        appendFn: (_path: string, line: string) => audit.push(line),
      },
      runBeadsSync,
    };
    return { audit, o, deps, ghCalls: () => ghCalls, syncCalls: () => syncCalls };
  }

  test("migrates one issue: edit + comment + audit + sync", async () => {
    const { audit, o, deps, ghCalls, syncCalls } = setup({
      issues: [issue({ number: 7, labels: [ghLabel("type::refactor")] })],
    });
    const code = await runTriageMigrateAxisValue(
      { axis: "type", from: "refactor", to: "chore", apply: true, limit: 0, sync: true },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    const calls = ghCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.subcommand).toBe("edit");
    expect(calls[0]!.args).toEqual([
      "7",
      "--add-label",
      "type::chore",
      "--remove-label",
      "type::refactor",
      "--repo",
      "bdelanghe/ai-home",
    ]);
    expect(calls[1]!.subcommand).toBe("comment");
    expect(calls[1]!.args[0]!).toBe("7");
    expect(calls[1]!.args[2]!).toMatch(
      /Migrated label `type::refactor` → `type::chore` \(GH-1059\)\./,
    );
    expect(syncCalls()).toBe(1);
    // 1 row entry + 1 sync entry.
    expect(audit).toHaveLength(2);
    const rowEntry = JSON.parse(audit[0]!);
    expect(rowEntry.action).toBe("edit");
    expect(rowEntry.from).toBe("refactor");
    expect(rowEntry.to).toBe("chore");
    const syncEntry = JSON.parse(audit[1]!);
    expect(syncEntry.action).toBe("sync");
    expect(syncEntry.touchedIssues).toEqual([7]);
  });

  test("empty plan: no gh calls, no sync, exit 0", async () => {
    const { o, deps, ghCalls, syncCalls } = setup({
      issues: [issue({ number: 8, labels: [ghLabel("type::chore")] })],
    });
    const code = await runTriageMigrateAxisValue(
      { axis: "type", from: "refactor", to: "chore", apply: true, limit: 0, sync: true },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    expect(ghCalls()).toHaveLength(0);
    expect(syncCalls()).toBe(0);
  });

  test("gh edit failure → action: error, no comment posted, exit 1", async () => {
    const { audit, o, deps, ghCalls, syncCalls } = setup({
      issues: [issue({ number: 9, labels: [ghLabel("type::refactor")] })],
      ghResults: [{ exitCode: 1, stdout: "", stderr: "boom", policy: null }],
    });
    const code = await runTriageMigrateAxisValue(
      { axis: "type", from: "refactor", to: "chore", apply: true, limit: 0, sync: true },
      o.output,
      deps,
    );
    expect(code).toBe(1);
    const calls = ghCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.subcommand).toBe("edit");
    expect(syncCalls()).toBe(0);
    const entry = JSON.parse(audit[0]!);
    expect(entry.action).toBe("error");
    expect(entry.stderr).toBe("boom");
  });

  test("gh edit ok + gh comment failure → partial-error, sync still runs, exit 1", async () => {
    const { audit, o, deps, ghCalls, syncCalls } = setup({
      issues: [issue({ number: 10, labels: [ghLabel("type::refactor")] })],
      ghResults: [
        { exitCode: 0, stdout: "", stderr: "", policy: null },
        { exitCode: 1, stdout: "", stderr: "comment-failed", policy: null },
      ],
    });
    const code = await runTriageMigrateAxisValue(
      { axis: "type", from: "refactor", to: "chore", apply: true, limit: 0, sync: true },
      o.output,
      deps,
    );
    expect(code).toBe(1);
    expect(ghCalls()).toHaveLength(2);
    // sync still runs because the label edit succeeded.
    expect(syncCalls()).toBe(1);
    const entry = JSON.parse(audit[0]!);
    expect(entry.action).toBe("partial-error");
  });

  test("--no-sync (sync: false) skips bd github sync after writes", async () => {
    const { o, deps, syncCalls } = setup({
      issues: [issue({ number: 11, labels: [ghLabel("type::refactor")] })],
    });
    const code = await runTriageMigrateAxisValue(
      { axis: "type", from: "refactor", to: "chore", apply: true, limit: 0, sync: false },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    expect(syncCalls()).toBe(0);
  });

  test("sync failure surfaces exit 1 even when row writes succeeded", async () => {
    const { o, deps, syncCalls } = setup({
      issues: [issue({ number: 12, labels: [ghLabel("type::refactor")] })],
      syncResult: { exitCode: 1, stdout: "", stderr: "sync exploded" },
    });
    const code = await runTriageMigrateAxisValue(
      { axis: "type", from: "refactor", to: "chore", apply: true, limit: 0, sync: true },
      o.output,
      deps,
    );
    expect(code).toBe(1);
    expect(syncCalls()).toBe(1);
  });

  test("idempotent re-run: no issues carry from-label → no calls, no sync, exit 0", async () => {
    const { audit, o, deps, ghCalls, syncCalls } = setup({
      issues: [
        issue({ number: 13, labels: [ghLabel("type::chore")] }),
        issue({ number: 14, labels: [ghLabel("type::task")] }),
      ],
    });
    const code = await runTriageMigrateAxisValue(
      { axis: "type", from: "refactor", to: "chore", apply: true, limit: 0, sync: true },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    expect(ghCalls()).toHaveLength(0);
    expect(syncCalls()).toBe(0);
    // No row entries (sync is also skipped when touchedIssues is empty).
    expect(audit).toHaveLength(0);
  });

  test("--limit caps the number of rows processed", async () => {
    const { o, deps, ghCalls } = setup({
      issues: [
        issue({ number: 1, labels: [ghLabel("type::refactor")] }),
        issue({ number: 2, labels: [ghLabel("type::refactor")] }),
        issue({ number: 3, labels: [ghLabel("type::refactor")] }),
      ],
    });
    const code = await runTriageMigrateAxisValue(
      { axis: "type", from: "refactor", to: "chore", apply: true, limit: 1, sync: false },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    // 1 issue × (edit + comment) = 2 gh calls.
    expect(ghCalls()).toHaveLength(2);
  });
});
