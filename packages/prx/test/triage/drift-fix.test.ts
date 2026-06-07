import { describe, expect, test } from "bun:test";

import {
  buildDriftFixPlan,
  runDriftFixActor,
  runTriageDriftFix,
  selectDriftFixDecision,
  type DriftFixAxis,
  type DriftFixPlan,
  type DriftFixPlanRow,
} from "../../src/triage/drift-fix.ts";
import type {
  BdDoctorResult,
  BdDuplicatesCluster,
  BdDuplicatesDryRunResult,
  BdExecResult,
  BdMergeOptions,
  BdMergeResult,
} from "@bounded-systems/bd";
import type { BeadsRecord, DriftRow } from "../../src/triage/triage.ts";
import { makeRunBeadsSyncMock } from "./sync-mock.ts";

function drift(overrides: Partial<DriftRow> = {}): DriftRow {
  return {
    issueNumber: 100,
    beadsId: "bd-100",
    fields: {},
    ...overrides,
  };
}

function bead(overrides: Partial<BeadsRecord> = {}): BeadsRecord {
  return {
    id: "bd-100",
    title: "stub",
    description: "",
    status: "open",
    priority: 2,
    issueType: "task",
    externalRef: "https://github.com/bdelanghe/ai-home/issues/100",
    externalRefs: { gh: "https://github.com/bdelanghe/ai-home/issues/100" },
    metadata: null,
    externalIssueNumber: 100,
    sourceSystem: null,
    ...overrides,
  };
}

function planFixture(rows: DriftFixPlanRow[]): DriftFixPlan {
  return {
    repo: "bdelanghe/ai-home",
    generatedAt: "2026-04-29T00:00:00.000Z",
    rows,
    duplicates: [],
    substrateHealth: { total: 0, fixable: 0, issues: [] },
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
  auditSink: {
    stateDirOverride: "/tmp/state",
    ensureDir: () => {},
  },
};

const ALL_AXES: readonly DriftFixAxis[] = ["type", "priority", "status"];

// GH-1255 — the four new fields default `true/true/false/true` at the Zod
// boundary; tests that pre-parse the options literal must include them. The
// `--no-dupes` / `--no-doctor` / `--doctor-fix` tests override individual
// fields explicitly.
const DRIFT_FIX_DEFAULTS = {
  includeDupes: true,
  includeDoctor: true,
  doctorFix: false,
  applyDupes: true,
} as const;

describe("selectDriftFixDecision", () => {
  test("type-only drift in BD enum → fix with axesFixed=[type]", async () => {
    const row = selectDriftFixDecision(
      drift({ fields: { type: { gh: "feature", bd: "task" } } }),
      ALL_AXES,
    );
    expect(row.decision).toBe("fix");
    expect(row.axesFixed).toEqual(["type"]);
    expect(row.type).toEqual({ gh: "feature", bd: "task" });
    expect(row.priority).toBeUndefined();
    expect(row.status).toBeUndefined();
  });

  test("type-only drift, GH=spike → skip:no-bd-type", async () => {
    const row = selectDriftFixDecision(
      drift({ fields: { type: { gh: "spike", bd: "task" } } }),
      ALL_AXES,
    );
    expect(row.decision).toBe("skip:no-bd-type");
    expect(row.axesFixed).toBeUndefined();
    expect(row.reason).toMatch(/spike/);
  });

  test("type-only drift, GH=refactor (out-of-vocab for typeLabelSchema) → skip:no-pair", async () => {
    // GH-1783: `refactor` is outside `typeLabelSchema`, so the Zod-validated
    // gate refuses to carry the pair forward. Was previously a `skip:no-bd-type`
    // catch-all; now the narrower out-of-vocab decision applies.
    const row = selectDriftFixDecision(
      drift({ fields: { type: { gh: "refactor", bd: "task" } } }),
      ALL_AXES,
    );
    expect(row.decision).toBe("skip:no-pair");
    expect(row.axesFixed).toBeUndefined();
    expect(row.type).toBeUndefined();
    expect(row.reason).toMatch(/out-of-vocab/);
  });

  test("priority-only drift → fix with axesFixed=[priority]", async () => {
    const row = selectDriftFixDecision(
      drift({ fields: { priority: { gh: "high", bd: "medium" } } }),
      ALL_AXES,
    );
    expect(row.decision).toBe("fix");
    expect(row.axesFixed).toEqual(["priority"]);
    expect(row.priority).toEqual({ gh: "high", bd: "medium" });
    expect(row.type).toBeUndefined();
  });

  test("priority drift with out-of-vocab GH label → skip:no-pair", async () => {
    // GH-1783 root cause: a legacy `priority::P1` label (or `p0`, `minor`,
    // etc.) used to flow through the inclusion gate (both sides non-null)
    // but failed Zod validation, producing `decision=fix` with `axesFixed`
    // including priority but no carried pair. Now `skip:no-pair`.
    const row = selectDriftFixDecision(
      drift({ fields: { priority: { gh: "P1", bd: "medium" } } }),
      ALL_AXES,
    );
    expect(row.decision).toBe("skip:no-pair");
    expect(row.axesFixed).toBeUndefined();
    expect(row.priority).toBeUndefined();
    expect(row.reason).toMatch(/out-of-vocab/);
    expect(row.reason).toMatch(/priority/);
  });

  test("out-of-vocab priority + valid status drift → skip:no-pair, status carried for audit", async () => {
    const row = selectDriftFixDecision(
      drift({
        fields: {
          priority: { gh: "p0", bd: "medium" },
          status: { gh: "open", bd: "closed" },
        },
      }),
      ALL_AXES,
    );
    expect(row.decision).toBe("skip:no-pair");
    expect(row.axesFixed).toBeUndefined();
    expect(row.priority).toBeUndefined();
    // Valid status pair still carried so audit log has full context.
    expect(row.status).toEqual({ gh: "open", bd: "closed" });
  });

  test("out-of-vocab priority but --axes type only → skip:axis-filtered (priority not in scope)", async () => {
    // No `skip:no-pair` since the operator didn't ask for priority.
    const row = selectDriftFixDecision(
      drift({ fields: { priority: { gh: "P1", bd: "medium" } } }),
      ["type"],
    );
    expect(row.decision).toBe("skip:axis-filtered");
  });

  test("type + priority drift, both in scope → fix with axesFixed=[type,priority]", async () => {
    const row = selectDriftFixDecision(
      drift({
        fields: {
          type: { gh: "feature", bd: "task" },
          priority: { gh: "critical", bd: "medium" },
        },
      }),
      ALL_AXES,
    );
    expect(row.decision).toBe("fix");
    expect(row.axesFixed).toEqual(["type", "priority"]);
    expect(row.type).toBeDefined();
    expect(row.priority).toBeDefined();
  });

  test("type + priority drift, --axes type only → fix with axesFixed=[type] (priority dropped)", async () => {
    const row = selectDriftFixDecision(
      drift({
        fields: {
          type: { gh: "feature", bd: "task" },
          priority: { gh: "critical", bd: "medium" },
        },
      }),
      ["type"],
    );
    expect(row.decision).toBe("fix");
    expect(row.axesFixed).toEqual(["type"]);
    // The carried priority pair stays so the audit log has full context.
    expect(row.priority).toBeDefined();
  });

  test("priority-only drift, --axes type only → skip:axis-filtered", async () => {
    const row = selectDriftFixDecision(
      drift({ fields: { priority: { gh: "high", bd: "medium" } } }),
      ["type"],
    );
    expect(row.decision).toBe("skip:axis-filtered");
  });

  test("title-only drift → skip:no-axis-drift", async () => {
    const row = selectDriftFixDecision(
      drift({ fields: { title: { gh: "new title", bd: "old title" } } }),
      ALL_AXES,
    );
    expect(row.decision).toBe("skip:no-axis-drift");
  });

  test("status-only drift, axes include status → fix with axesFixed=[status]", async () => {
    const row = selectDriftFixDecision(
      drift({ fields: { status: { gh: "open", bd: "closed" } } }),
      ALL_AXES,
    );
    expect(row.decision).toBe("fix");
    expect(row.axesFixed).toEqual(["status"]);
    expect(row.status).toEqual({ gh: "open", bd: "closed" });
  });

  test("status-only drift, --axes type,priority → skip:axis-filtered", async () => {
    const row = selectDriftFixDecision(
      drift({ fields: { status: { gh: "open", bd: "closed" } } }),
      ["type", "priority"],
    );
    expect(row.decision).toBe("skip:axis-filtered");
    // Status pair still carried so audit log has full context.
    expect(row.status).toEqual({ gh: "open", bd: "closed" });
  });

  test("type + status drift, axes=all → fix with axesFixed=[type,status]", async () => {
    const row = selectDriftFixDecision(
      drift({
        fields: {
          type: { gh: "feature", bd: "task" },
          status: { gh: "open", bd: "closed" },
        },
      }),
      ALL_AXES,
    );
    expect(row.decision).toBe("fix");
    expect(row.axesFixed).toEqual(["type", "status"]);
  });

  test("type + priority + status drift, axes=all → axesFixed=[type,priority,status]", async () => {
    const row = selectDriftFixDecision(
      drift({
        fields: {
          type: { gh: "bug", bd: "task" },
          priority: { gh: "high", bd: "low" },
          status: { gh: "open", bd: "closed" },
        },
      }),
      ALL_AXES,
    );
    expect(row.decision).toBe("fix");
    expect(row.axesFixed).toEqual(["type", "priority", "status"]);
  });

  test("spike type drift co-occurring with status drift → skip:no-bd-type (hard skip, no partial fix)", async () => {
    const row = selectDriftFixDecision(
      drift({
        fields: {
          type: { gh: "spike", bd: "task" },
          status: { gh: "open", bd: "closed" },
        },
      }),
      ALL_AXES,
    );
    expect(row.decision).toBe("skip:no-bd-type");
    // Carries pairs through so the audit log has the full picture.
    expect(row.status).toEqual({ gh: "open", bd: "closed" });
  });

  test("spike type drift co-occurring with priority drift → skip:no-bd-type", async () => {
    const row = selectDriftFixDecision(
      drift({
        fields: {
          type: { gh: "spike", bd: "task" },
          priority: { gh: "high", bd: "medium" },
        },
      }),
      ALL_AXES,
    );
    expect(row.decision).toBe("skip:no-bd-type");
    expect(row.priority).toEqual({ gh: "high", bd: "medium" });
  });
});

describe("buildDriftFixPlan", () => {
  test("groups decisions across mixed drift rows", async () => {
    const rows = buildDriftFixPlan(
      [
        drift({ issueNumber: 1, beadsId: "bd-1", fields: { type: { gh: "feature", bd: "task" } } }),
        drift({ issueNumber: 2, beadsId: "bd-2", fields: { type: { gh: "spike", bd: "task" } } }),
        drift({
          issueNumber: 3,
          beadsId: "bd-3",
          fields: {
            type: { gh: "bug", bd: "task" },
            priority: { gh: "critical", bd: "medium" },
          },
        }),
        drift({ issueNumber: 4, beadsId: "bd-4", fields: { priority: { gh: "low", bd: "high" } } }),
        drift({ issueNumber: 5, beadsId: "bd-5", fields: { title: { gh: "x", bd: "y" } } }),
        drift({ issueNumber: 6, beadsId: "bd-6", fields: { status: { gh: "open", bd: "closed" } } }),
      ],
      "bdelanghe/ai-home",
      "2026-04-29T00:00:00Z",
      ALL_AXES,
    );
    const summary = rows.rows.map((r) =>
      r.decision === "fix"
        ? `${r.issueNumber}:fix(${(r.axesFixed ?? []).join("+")})`
        : `${r.issueNumber}:${r.decision}`,
    );
    expect(summary).toEqual([
      "1:fix(type)",
      "2:skip:no-bd-type",
      "3:fix(type+priority)",
      "4:fix(priority)",
      "5:skip:no-axis-drift",
      "6:fix(status)",
    ]);
  });

  test("empty drift produces empty plan rows", async () => {
    const plan = buildDriftFixPlan([], "bdelanghe/ai-home", "2026-04-29T00:00:00Z", ALL_AXES);
    expect(plan.rows).toEqual([]);
  });

  test("plan schema rejects fix decision with empty axesFixed", async () => {
    const { driftFixPlanSchema } = require("../../src/triage/drift-fix.ts");
    expect(() =>
      driftFixPlanSchema.parse({
        repo: "x/y",
        generatedAt: "now",
        rows: [
          {
            issueNumber: 1,
            beadsId: "bd-1",
            decision: "fix",
            reason: "x",
            axesFixed: [],
          },
        ],
      }),
    ).toThrow();
  });

  test("plan schema rejects axesFixed on non-fix decisions", async () => {
    const { driftFixPlanSchema } = require("../../src/triage/drift-fix.ts");
    expect(() =>
      driftFixPlanSchema.parse({
        repo: "x/y",
        generatedAt: "now",
        rows: [
          {
            issueNumber: 1,
            beadsId: "bd-1",
            decision: "skip:no-axis-drift",
            reason: "x",
            axesFixed: ["type"],
          },
        ],
      }),
    ).toThrow();
  });

  test("plan schema rejects fix decision with axesFixed=[priority] missing priority pair (GH-1783)", async () => {
    const { driftFixPlanSchema } = require("../../src/triage/drift-fix.ts");
    expect(() =>
      driftFixPlanSchema.parse({
        repo: "x/y",
        generatedAt: "now",
        rows: [
          {
            issueNumber: 1010,
            beadsId: "bd-1010",
            decision: "fix",
            reason: "priority drift in scope",
            axesFixed: ["priority"],
          },
        ],
      }),
    ).toThrow(/priority/);
  });

  test("plan schema rejects fix decision with axesFixed=[type] missing type pair", async () => {
    const { driftFixPlanSchema } = require("../../src/triage/drift-fix.ts");
    expect(() =>
      driftFixPlanSchema.parse({
        repo: "x/y",
        generatedAt: "now",
        rows: [
          {
            issueNumber: 2,
            beadsId: "bd-2",
            decision: "fix",
            reason: "type drift in scope",
            axesFixed: ["type"],
          },
        ],
      }),
    ).toThrow(/type/);
  });

  test("plan schema rejects fix decision with axesFixed=[status] missing status pair", async () => {
    const { driftFixPlanSchema } = require("../../src/triage/drift-fix.ts");
    expect(() =>
      driftFixPlanSchema.parse({
        repo: "x/y",
        generatedAt: "now",
        rows: [
          {
            issueNumber: 3,
            beadsId: "bd-3",
            decision: "fix",
            reason: "status drift in scope",
            axesFixed: ["status"],
          },
        ],
      }),
    ).toThrow(/status/);
  });

  // Residual superRefine arms (GH-1255) — the fix / fix:dupe / non-fix branches
  // each gate cross-field shape; the row schema is the contract for hand-built
  // `--from` plans, so every refusal must be exercised.
  test("plan schema rejects fix decision with a non-positive issueNumber", async () => {
    const { driftFixPlanRowSchema } = require("../../src/triage/drift-fix.ts");
    const r = driftFixPlanRowSchema.safeParse({
      issueNumber: 0,
      beadsId: "bd-9",
      decision: "fix",
      reason: "type drift",
      axesFixed: ["type"],
      type: { gh: "bug", bd: "task" },
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error)).toContain("positive GH issue number");
  });

  test("plan schema rejects a fix row carrying a dupe payload", async () => {
    const { driftFixPlanRowSchema } = require("../../src/triage/drift-fix.ts");
    const r = driftFixPlanRowSchema.safeParse({
      issueNumber: 7,
      beadsId: "bd-7",
      decision: "fix",
      reason: "type drift",
      axesFixed: ["type"],
      type: { gh: "bug", bd: "task" },
      dupe: { target: "bd-1", source: "bd-7", parityOk: true, parityReason: null },
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error)).toContain("dupe carrier only allowed when decision=fix:dupe");
  });

  test("plan schema rejects a fix:dupe row missing its dupe carrier", async () => {
    const { driftFixPlanRowSchema } = require("../../src/triage/drift-fix.ts");
    const r = driftFixPlanRowSchema.safeParse({
      issueNumber: 8,
      beadsId: "bd-8",
      decision: "fix:dupe",
      reason: "dupe",
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error)).toContain("requires a dupe carrier");
  });

  test("plan schema rejects a fix:dupe row carrying axesFixed", async () => {
    const { driftFixPlanRowSchema } = require("../../src/triage/drift-fix.ts");
    const r = driftFixPlanRowSchema.safeParse({
      issueNumber: 9,
      beadsId: "bd-9",
      decision: "fix:dupe",
      reason: "dupe",
      axesFixed: ["type"],
      dupe: { target: "bd-1", source: "bd-9", parityOk: true, parityReason: null },
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error)).toContain("axesFixed only allowed when decision=fix");
  });

  test("plan schema rejects a non-fix row with a non-positive issueNumber", async () => {
    const { driftFixPlanRowSchema } = require("../../src/triage/drift-fix.ts");
    const r = driftFixPlanRowSchema.safeParse({
      issueNumber: 0,
      beadsId: "bd-10",
      decision: "skip:no-axis-drift",
      reason: "title only",
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error)).toContain("non-fix rows require a positive GH issue number");
  });

  test("plan schema rejects a non-fix row carrying a dupe payload", async () => {
    const { driftFixPlanRowSchema } = require("../../src/triage/drift-fix.ts");
    const r = driftFixPlanRowSchema.safeParse({
      issueNumber: 11,
      beadsId: "bd-11",
      decision: "skip:no-pair",
      reason: "out-of-vocab",
      dupe: { target: "bd-1", source: "bd-11", parityOk: true, parityReason: null },
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error)).toContain("dupe carrier only allowed when decision=fix:dupe");
  });
});

describe("runTriageDriftFix — scan phase", () => {
  test("emits a JSON plan to stdout when --from and --apply are omitted", async () => {
    const o = makeOutput();
    const code = await runTriageDriftFix(
      { apply: false, dryRun: false, limit: 0, axes: [...ALL_AXES], sync: true, ...DRIFT_FIX_DEFAULTS },
      o.output,
      {
        ...STD_DEPS_BASE,
        listOpenIssues: () => [
          {
            number: 7,
            title: "feat: x",
            url: "https://github.com/bdelanghe/ai-home/issues/7",
            labels: [{ name: "type::feature" }, { name: "priority::high" }],
          },
        ],
        repoNameWithOwner: () => "bdelanghe/ai-home",
        loadAllBeads: () => [
          bead({
            id: "bd-7",
            issueType: "task",
            priority: 2,
            externalRef: "https://github.com/bdelanghe/ai-home/issues/7",
            externalIssueNumber: 7,
          }),
        ],
        cwd: () => "/tmp/repo",
      },
    );
    expect(code).toBe(0);
    expect(o.log).toHaveLength(1);
    const plan = JSON.parse(o.log[0]!) as DriftFixPlan;
    expect(plan.repo).toBe("bdelanghe/ai-home");
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]!.decision).toBe("fix");
    expect(plan.rows[0]!.axesFixed).toEqual(["type", "priority"]);
  });

  test("scan picks up bd=closed/gh=open as status drift when --axes status is in scope", async () => {
    const o = makeOutput();
    const code = await runTriageDriftFix(
      { apply: false, dryRun: false, limit: 0, axes: ["status"], sync: true, ...DRIFT_FIX_DEFAULTS },
      o.output,
      {
        ...STD_DEPS_BASE,
        listOpenIssues: () => [
          {
            number: 9,
            title: "stale issue",
            url: "https://github.com/bdelanghe/ai-home/issues/9",
            labels: [],
          },
        ],
        repoNameWithOwner: () => "bdelanghe/ai-home",
        loadAllBeads: () => [
          bead({
            id: "bd-9",
            title: "stale issue",
            status: "closed",
            externalRef: "https://github.com/bdelanghe/ai-home/issues/9",
            externalIssueNumber: 9,
          }),
        ],
        cwd: () => "/tmp/repo",
      },
    );
    expect(code).toBe(0);
    const plan = JSON.parse(o.log[0]!) as DriftFixPlan;
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]!.decision).toBe("fix");
    expect(plan.rows[0]!.axesFixed).toEqual(["status"]);
    expect(plan.rows[0]!.status).toEqual({ gh: "open", bd: "closed" });
  });

  test("clean queue → empty plan rows, exit 0", async () => {
    const o = makeOutput();
    const code = await runTriageDriftFix(
      { apply: false, dryRun: false, limit: 0, axes: [...ALL_AXES], sync: true, ...DRIFT_FIX_DEFAULTS },
      o.output,
      {
        ...STD_DEPS_BASE,
        listOpenIssues: () => [],
        repoNameWithOwner: () => "bdelanghe/ai-home",
        loadAllBeads: () => [],
        cwd: () => "/tmp/repo",
      },
    );
    expect(code).toBe(0);
    const plan = JSON.parse(o.log[0]!) as DriftFixPlan;
    expect(plan.rows).toEqual([]);
  });
});

describe("runTriageDriftFix — apply phase (--from)", () => {
  function setup(rows: DriftFixPlanRow[], options: {
    bdResults?: BdExecResult[];
    beadsAtApply?: BeadsRecord[];
    syncResult?: { exitCode: number; stdout: string; stderr: string };
  } = {}) {
    const audit: string[] = [];
    // GH-296 / prx-ebo: writes now go through the daemon helpers (updateBead /
    // reopenBead), not execBd. The fakes record the SAME {subcommand, args}
    // shape the old `bd update`/`bd reopen` produced (id + --type/-p), so the
    // existing call assertions hold; `bdResults` still drives failure injection
    // (consumed in write order), mapped to the helpers' throw-on-error contract.
    const bdCalls: Array<{ subcommand: string; args: string[] }> = [];
    let bdIndex = 0;
    const bdResults = options.bdResults ?? [];
    const nextResult = (): BdExecResult => {
      const result = bdResults[bdIndex] ?? { exitCode: 0, stdout: "", stderr: "", policy: null };
      bdIndex += 1;
      return result;
    };
    // execBd no longer carries writes; keep an inert stub for any non-write path.
    const execBd = (): BdExecResult => ({ exitCode: 0, stdout: "", stderr: "", policy: null });
    const updateBead = async (id: string, fields: { issueType?: string; priority?: number }) => {
      const args = [id];
      if (fields.issueType !== undefined) args.push("--type", fields.issueType);
      if (fields.priority !== undefined) args.push("-p", String(fields.priority));
      bdCalls.push({ subcommand: "update", args });
      const r = nextResult();
      if (r.exitCode !== 0) throw new Error(r.stderr || r.stdout || "bd update failed");
      return null;
    };
    const reopenBead = async (id: string) => {
      bdCalls.push({ subcommand: "reopen", args: [id] });
      const r = nextResult();
      if (r.exitCode !== 0) throw new Error(r.stderr || r.stdout || "bd reopen failed");
      return null;
    };
    let syncCalls = 0;
    // GH-2316: status-only canonical reconcile seam (replaces the retired
    // destructive `bd github sync --pull-only --prefer-github` shell-out).
    const runBeadsSync = makeRunBeadsSyncMock(
      options.syncResult ?? { exitCode: 0, stdout: "", stderr: "" },
      () => {
        syncCalls += 1;
      },
    );
    const fixture = JSON.stringify(planFixture(rows));
    const o = makeOutput();
    const deps = {
      ...STD_DEPS_BASE,
      execBd,
      updateBead,
      reopenBead,
      readFileSync: () => fixture,
      loadAllBeads: () => options.beadsAtApply ?? [],
      auditSink: {
        ...STD_DEPS_BASE.auditSink,
        appendFn: (_path: string, line: string) => audit.push(line),
      },
      runBeadsSync,
    };
    return {
      audit,
      o,
      deps,
      bdCalls,
      syncCalls: () => syncCalls,
    };
  }

  function fixTypeRow(overrides: Partial<DriftFixPlanRow> = {}): DriftFixPlanRow {
    return {
      issueNumber: 42,
      beadsId: "bd-42",
      decision: "fix",
      axesFixed: ["type"],
      reason: "type drift in scope",
      type: { gh: "feature", bd: "task" },
      ...overrides,
    };
  }

  function fixPriorityRow(overrides: Partial<DriftFixPlanRow> = {}): DriftFixPlanRow {
    return {
      issueNumber: 43,
      beadsId: "bd-43",
      decision: "fix",
      axesFixed: ["priority"],
      reason: "priority drift in scope",
      priority: { gh: "critical", bd: "medium" },
      ...overrides,
    };
  }

  function fixBothRow(overrides: Partial<DriftFixPlanRow> = {}): DriftFixPlanRow {
    return {
      issueNumber: 44,
      beadsId: "bd-44",
      decision: "fix",
      axesFixed: ["type", "priority"],
      reason: "type+priority drift in scope",
      type: { gh: "bug", bd: "task" },
      priority: { gh: "high", bd: "medium" },
      ...overrides,
    };
  }

  function fixStatusRow(overrides: Partial<DriftFixPlanRow> = {}): DriftFixPlanRow {
    return {
      issueNumber: 45,
      beadsId: "bd-45",
      decision: "fix",
      axesFixed: ["status"],
      reason: "status drift in scope",
      status: { gh: "open", bd: "closed" },
      ...overrides,
    };
  }

  test("dry-run writes audit entries and skips bd update", async () => {
    const { audit, o, deps, bdCalls, syncCalls } = setup([fixTypeRow()]);
    const code = await runTriageDriftFix(
      { from: "/tmp/p.json", apply: false, dryRun: true, limit: 0, axes: [...ALL_AXES], sync: true, ...DRIFT_FIX_DEFAULTS },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    expect(bdCalls).toHaveLength(0);
    expect(syncCalls()).toBe(0);
    expect(audit).toHaveLength(1);
    const entry = JSON.parse(audit[0]!);
    expect(entry.action).toBe("update");
    expect(entry.dryRun).toBe(true);
    expect(entry.beforeAfter.type).toEqual({ before: "task", after: "feature" });
  });

  test("non-fix rows are skipped without writes", async () => {
    const skipRows: DriftFixPlanRow[] = [
      {
        issueNumber: 2,
        beadsId: "bd-2",
        decision: "skip:axis-filtered",
        reason: "filtered",
      },
      {
        issueNumber: 3,
        beadsId: "bd-3",
        decision: "skip:no-axis-drift",
        reason: "title only",
      },
    ];
    const audit: string[] = [];
    const bdCalls: Array<{ args: string[] }> = [];
    const o = makeOutput();
    const fixture = JSON.stringify(planFixture(skipRows));
    const code = await runTriageDriftFix(
      { from: "/tmp/p.json", apply: false, dryRun: false, limit: 0, axes: [...ALL_AXES], sync: true, ...DRIFT_FIX_DEFAULTS },
      o.output,
      {
        ...STD_DEPS_BASE,
        execBd: (opts) => {
          bdCalls.push({ args: opts.args });
          return { exitCode: 0, stdout: "", stderr: "", policy: null };
        },
        readFileSync: () => fixture,
        loadAllBeads: () => [],
        auditSink: {
          stateDirOverride: "/tmp/state",
          ensureDir: () => {},
          appendFn: (_path: string, line: string) => audit.push(line),
        },
        runBeadsSync: makeRunBeadsSyncMock({ exitCode: 0 }),
      },
    );
    expect(code).toBe(0);
    expect(bdCalls).toHaveLength(0);
    expect(audit).toHaveLength(2);
    for (const line of audit) {
      expect(JSON.parse(line).action).toBe("skip");
    }
  });

  test("skip:no-pair row → audit skip, no bd call, no sync, exit 0 (GH-1783)", async () => {
    const noPairRow: DriftFixPlanRow = {
      issueNumber: 1010,
      beadsId: "bd-1010",
      decision: "skip:no-pair",
      reason: "priority drift exists but GH label out-of-vocab; cannot pair",
    };
    const { audit, o, deps, bdCalls, syncCalls } = setup([noPairRow]);
    const code = await runTriageDriftFix(
      { from: "/tmp/p.json", apply: false, dryRun: false, limit: 0, axes: [...ALL_AXES], sync: true, ...DRIFT_FIX_DEFAULTS },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    expect(bdCalls).toHaveLength(0);
    expect(syncCalls()).toBe(0);
    expect(audit).toHaveLength(1);
    const entry = JSON.parse(audit[0]!);
    expect(entry.action).toBe("skip");
    expect(entry.decision).toBe("skip:no-pair");
    expect(o.log.some((line) => line === "skip GH-1010 (skip:no-pair)")).toBe(true);
    expect(o.log.some((line) => line.includes("writes=0 skips=1 errors=0"))).toBe(true);
  });

  test("fix-type row calls bd update with --type and chains sync", async () => {
    const { audit, o, deps, bdCalls, syncCalls } = setup([fixTypeRow()]);
    const code = await runTriageDriftFix(
      { from: "/tmp/p.json", apply: false, dryRun: false, limit: 0, axes: [...ALL_AXES], sync: true, ...DRIFT_FIX_DEFAULTS },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    expect(bdCalls).toHaveLength(1);
    expect(bdCalls[0]!.subcommand).toBe("update");
    expect(bdCalls[0]!.args[0]).toBe("bd-42");
    expect(bdCalls[0]!.args).toContain("--type");
    expect(bdCalls[0]!.args).toContain("feature");
    expect(bdCalls[0]!.args).not.toContain("-p");
    expect(syncCalls()).toBe(1);
    // 1 row entry + 1 sync entry
    expect(audit).toHaveLength(2);
    const rowEntry = JSON.parse(audit[0]!);
    expect(rowEntry.action).toBe("update");
    expect(rowEntry.axesFixed).toEqual(["type"]);
    const syncEntry = JSON.parse(audit[1]!);
    expect(syncEntry.action).toBe("sync");
    expect(syncEntry.touchedIssues).toEqual([42]);
  });

  test("fix-priority row maps critical→0, high→1, medium→2, low→3", async () => {
    const cases: Array<["critical" | "high" | "medium" | "low", string]> = [
      ["critical", "0"],
      ["high", "1"],
      ["medium", "2"],
      ["low", "3"],
    ];
    for (const [label, expected] of cases) {
      const { o, deps, bdCalls } = setup([
        fixPriorityRow({ priority: { gh: label, bd: "low" } }),
      ]);
      await runTriageDriftFix(
        { from: "/tmp/p.json", apply: false, dryRun: false, limit: 0, axes: [...ALL_AXES], sync: false, ...DRIFT_FIX_DEFAULTS },
        o.output,
        deps,
      );
      const idx = bdCalls[0]!.args.indexOf("-p");
      expect(bdCalls[0]!.args[idx + 1]).toBe(expected);
    }
  });

  test("type+priority row passes --type and -p in one bd update call", async () => {
    const { o, deps, bdCalls } = setup([fixBothRow()]);
    await runTriageDriftFix(
      { from: "/tmp/p.json", apply: false, dryRun: false, limit: 0, axes: [...ALL_AXES], sync: false, ...DRIFT_FIX_DEFAULTS },
      o.output,
      deps,
    );
    expect(bdCalls).toHaveLength(1);
    expect(bdCalls[0]!.subcommand).toBe("update");
    expect(bdCalls[0]!.args).toEqual(["bd-44", "--type", "bug", "-p", "1"]);
  });

  test("status-only row calls bd reopen exactly once, no bd update", async () => {
    const { audit, o, deps, bdCalls, syncCalls } = setup([fixStatusRow()]);
    const code = await runTriageDriftFix(
      { from: "/tmp/p.json", apply: false, dryRun: false, limit: 0, axes: [...ALL_AXES], sync: true, ...DRIFT_FIX_DEFAULTS },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    expect(bdCalls).toHaveLength(1);
    expect(bdCalls[0]!.subcommand).toBe("reopen");
    expect(bdCalls[0]!.args).toEqual(["bd-45"]);
    expect(syncCalls()).toBe(1);
    const rowEntry = JSON.parse(audit[0]!);
    expect(rowEntry.action).toBe("update");
    expect(rowEntry.axesFixed).toEqual(["status"]);
    expect(rowEntry.beforeAfter.status).toEqual({ before: "closed", after: "open" });
  });

  test("type+status row calls bd update then bd reopen, single audit entry", async () => {
    const row: DriftFixPlanRow = {
      issueNumber: 46,
      beadsId: "bd-46",
      decision: "fix",
      axesFixed: ["type", "status"],
      reason: "type+status drift",
      type: { gh: "feature", bd: "task" },
      status: { gh: "open", bd: "closed" },
    };
    const { audit, o, deps, bdCalls } = setup([row]);
    const code = await runTriageDriftFix(
      { from: "/tmp/p.json", apply: false, dryRun: false, limit: 0, axes: [...ALL_AXES], sync: false, ...DRIFT_FIX_DEFAULTS },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    expect(bdCalls).toHaveLength(2);
    expect(bdCalls[0]!.subcommand).toBe("update");
    expect(bdCalls[0]!.args).toEqual(["bd-46", "--type", "feature"]);
    expect(bdCalls[1]!.subcommand).toBe("reopen");
    expect(bdCalls[1]!.args).toEqual(["bd-46"]);
    // 1 row entry only — no sync (sync: false)
    expect(audit).toHaveLength(1);
    const rowEntry = JSON.parse(audit[0]!);
    expect(rowEntry.action).toBe("update");
    expect(rowEntry.axesFixed).toEqual(["type", "status"]);
    expect(rowEntry.beforeAfter.type).toEqual({ before: "task", after: "feature" });
    expect(rowEntry.beforeAfter.status).toEqual({ before: "closed", after: "open" });
  });

  test("bd reopen failure after successful bd update → error entry, partial axesFixed, exit 1", async () => {
    const row: DriftFixPlanRow = {
      issueNumber: 47,
      beadsId: "bd-47",
      decision: "fix",
      axesFixed: ["type", "status"],
      reason: "type+status drift",
      type: { gh: "feature", bd: "task" },
      status: { gh: "open", bd: "closed" },
    };
    const { audit, o, deps, bdCalls } = setup([row], {
      bdResults: [
        { exitCode: 0, stdout: "", stderr: "", policy: null },
        { exitCode: 1, stdout: "", stderr: "bd reopen failed", policy: null },
      ],
    });
    const code = await runTriageDriftFix(
      { from: "/tmp/p.json", apply: false, dryRun: false, limit: 0, axes: [...ALL_AXES], sync: true, ...DRIFT_FIX_DEFAULTS },
      o.output,
      deps,
    );
    expect(code).toBe(1);
    expect(bdCalls).toHaveLength(2);
    const errorEntry = JSON.parse(audit[0]!);
    expect(errorEntry.action).toBe("error");
    // type went through, status didn't — partial state recorded.
    expect(errorEntry.axesFixed).toEqual(["type"]);
    expect(errorEntry.exitCode).toBe(1);
  });

  test("bd reopen failure on status-only row → error, no writes, no sync", async () => {
    const { audit, o, deps, bdCalls, syncCalls } = setup([fixStatusRow()], {
      bdResults: [{ exitCode: 1, stdout: "", stderr: "issue not found", policy: null }],
    });
    const code = await runTriageDriftFix(
      { from: "/tmp/p.json", apply: false, dryRun: false, limit: 0, axes: [...ALL_AXES], sync: true, ...DRIFT_FIX_DEFAULTS },
      o.output,
      deps,
    );
    expect(code).toBe(1);
    expect(bdCalls).toHaveLength(1);
    expect(syncCalls()).toBe(0); // writes==0 → sync skipped
    const entry = JSON.parse(audit[0]!);
    expect(entry.action).toBe("error");
    expect(entry.axesFixed).toEqual([]);
  });

  test("priority::none in a fix row → error, no bd write", async () => {
    const row: DriftFixPlanRow = {
      issueNumber: 50,
      beadsId: "bd-50",
      decision: "fix",
      axesFixed: ["priority"],
      reason: "operator hand-edited",
      priority: { gh: "none", bd: "medium" },
    };
    const { audit, o, deps, bdCalls } = setup([row]);
    const code = await runTriageDriftFix(
      { from: "/tmp/p.json", apply: false, dryRun: false, limit: 0, axes: [...ALL_AXES], sync: true, ...DRIFT_FIX_DEFAULTS },
      o.output,
      deps,
    );
    expect(code).toBe(1);
    expect(bdCalls).toHaveLength(0);
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!).action).toBe("error");
  });

  test("idempotency: bd already matches GH at apply time (type) → skip, no bd write", async () => {
    const { audit, o, deps, bdCalls, syncCalls } = setup(
      [fixTypeRow({ issueNumber: 42, beadsId: "bd-42", type: { gh: "feature", bd: "task" } })],
      {
        beadsAtApply: [bead({ id: "bd-42", issueType: "feature" })],
      },
    );
    const code = await runTriageDriftFix(
      { from: "/tmp/p.json", apply: false, dryRun: false, limit: 0, axes: [...ALL_AXES], sync: true, ...DRIFT_FIX_DEFAULTS },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    expect(bdCalls).toHaveLength(0);
    expect(syncCalls()).toBe(0);
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!).action).toBe("skip");
  });

  test("idempotency: bd already at status=open → status row skipped", async () => {
    const { audit, o, deps, bdCalls } = setup(
      [fixStatusRow({ beadsId: "bd-45" })],
      {
        beadsAtApply: [bead({ id: "bd-45", status: "open" })],
      },
    );
    const code = await runTriageDriftFix(
      { from: "/tmp/p.json", apply: false, dryRun: false, limit: 0, axes: [...ALL_AXES], sync: true, ...DRIFT_FIX_DEFAULTS },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    expect(bdCalls).toHaveLength(0);
    expect(JSON.parse(audit[0]!).action).toBe("skip");
  });

  test("--limit truncates the plan", async () => {
    const { audit, o, deps } = setup([
      fixTypeRow({ issueNumber: 1, beadsId: "bd-1" }),
      fixTypeRow({ issueNumber: 2, beadsId: "bd-2" }),
      fixTypeRow({ issueNumber: 3, beadsId: "bd-3" }),
    ]);
    await runTriageDriftFix(
      { from: "/tmp/p.json", apply: false, dryRun: true, limit: 2, axes: [...ALL_AXES], sync: true, ...DRIFT_FIX_DEFAULTS },
      o.output,
      deps,
    );
    // 2 row entries, no sync (dry-run)
    expect(audit).toHaveLength(2);
  });

  test("--no-sync skips chained sync even when writes occur", async () => {
    const { o, deps, syncCalls } = setup([fixTypeRow()]);
    await runTriageDriftFix(
      { from: "/tmp/p.json", apply: false, dryRun: false, limit: 0, axes: [...ALL_AXES], sync: false, ...DRIFT_FIX_DEFAULTS },
      o.output,
      deps,
    );
    expect(syncCalls()).toBe(0);
  });

  test("sync failure → exit 1", async () => {
    const { o, deps } = setup([fixTypeRow()], {
      syncResult: { exitCode: 1, stdout: "", stderr: "boom" },
    });
    const code = await runTriageDriftFix(
      { from: "/tmp/p.json", apply: false, dryRun: false, limit: 0, axes: [...ALL_AXES], sync: true, ...DRIFT_FIX_DEFAULTS },
      o.output,
      deps,
    );
    expect(code).toBe(1);
  });

  test("bd update failure → row marked error, exit 1", async () => {
    const { audit, o, deps, bdCalls } = setup([fixTypeRow()], {
      bdResults: [{ exitCode: 2, stdout: "", stderr: "bd-safe: nope", policy: null }],
    });
    const code = await runTriageDriftFix(
      { from: "/tmp/p.json", apply: false, dryRun: false, limit: 0, axes: [...ALL_AXES], sync: true, ...DRIFT_FIX_DEFAULTS },
      o.output,
      deps,
    );
    expect(code).toBe(1);
    expect(bdCalls).toHaveLength(1);
    const entry = JSON.parse(audit[0]!);
    expect(entry.action).toBe("error");
    // The daemon helper throws (no bd exit code); drift-fix records exitCode 1
    // and surfaces the daemon's error message.
    expect(entry.exitCode).toBe(1);
    expect(entry.stderr).toContain("bd-safe: nope");
  });

  test("empty plan → no writes, no sync, exit 0", async () => {
    const { audit, o, deps, bdCalls, syncCalls } = setup([]);
    const code = await runTriageDriftFix(
      { from: "/tmp/p.json", apply: false, dryRun: false, limit: 0, axes: [...ALL_AXES], sync: true, ...DRIFT_FIX_DEFAULTS },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    expect(bdCalls).toHaveLength(0);
    expect(syncCalls()).toBe(0);
    expect(audit).toHaveLength(0);
  });
});

describe("runTriageDriftFix — one-shot apply (--apply)", () => {
  test("--apply scans GH+bd and writes in a single invocation", async () => {
    const audit: string[] = [];
    const bdCalls: Array<{ subcommand: string; args: string[] }> = [];
    let syncCalls = 0;
    const o = makeOutput();
    const code = await runTriageDriftFix(
      { apply: true, dryRun: false, limit: 0, axes: [...ALL_AXES], sync: true, ...DRIFT_FIX_DEFAULTS },
      o.output,
      {
        ...STD_DEPS_BASE,
        listOpenIssues: () => [
          {
            number: 8,
            title: "stale",
            url: "https://github.com/bdelanghe/ai-home/issues/8",
            labels: [],
          },
        ],
        repoNameWithOwner: () => "bdelanghe/ai-home",
        loadAllBeads: () => [
          bead({
            id: "bd-8",
            title: "stale",
            status: "closed",
            externalRef: "https://github.com/bdelanghe/ai-home/issues/8",
            externalIssueNumber: 8,
          }),
        ],
        cwd: () => "/tmp/repo",
        // GH-296 / prx-ebo: writes via the daemon helpers, recorded in the same
        // {subcommand, args} shape the old bd path produced.
        updateBead: async (id: string, fields: { issueType?: string; priority?: number }) => {
          const args = [id];
          if (fields.issueType !== undefined) args.push("--type", fields.issueType);
          if (fields.priority !== undefined) args.push("-p", String(fields.priority));
          bdCalls.push({ subcommand: "update", args });
          return null;
        },
        reopenBead: async (id: string) => {
          bdCalls.push({ subcommand: "reopen", args: [id] });
          return null;
        },
        auditSink: {
          stateDirOverride: "/tmp/state",
          ensureDir: () => {},
          appendFn: (_path: string, line: string) => audit.push(line),
        },
        runBeadsSync: makeRunBeadsSyncMock({ exitCode: 0 }, () => {
          syncCalls += 1;
        }),
      },
    );
    expect(code).toBe(0);
    expect(bdCalls).toHaveLength(1);
    expect(bdCalls[0]!.subcommand).toBe("reopen");
    expect(bdCalls[0]!.args).toEqual(["bd-8"]);
    expect(syncCalls).toBe(1);
    const rowEntry = JSON.parse(audit[0]!);
    expect(rowEntry.action).toBe("update");
    expect(rowEntry.axesFixed).toEqual(["status"]);
  });

  test("--apply with --dry-run plans but does not write", async () => {
    const bdCalls: string[] = [];
    let syncCalls = 0;
    const o = makeOutput();
    const code = await runTriageDriftFix(
      { apply: true, dryRun: true, limit: 0, axes: [...ALL_AXES], sync: true, ...DRIFT_FIX_DEFAULTS },
      o.output,
      {
        ...STD_DEPS_BASE,
        listOpenIssues: () => [
          {
            number: 9,
            title: "stale",
            url: "https://github.com/bdelanghe/ai-home/issues/9",
            labels: [],
          },
        ],
        repoNameWithOwner: () => "bdelanghe/ai-home",
        loadAllBeads: () => [
          bead({
            id: "bd-9",
            title: "stale",
            status: "closed",
            externalRef: "https://github.com/bdelanghe/ai-home/issues/9",
            externalIssueNumber: 9,
          }),
        ],
        cwd: () => "/tmp/repo",
        execBd: (opts) => {
          bdCalls.push(opts.subcommand);
          return { exitCode: 0, stdout: "", stderr: "", policy: null };
        },
        auditSink: {
          stateDirOverride: "/tmp/state",
          ensureDir: () => {},
          appendFn: () => {},
        },
        runBeadsSync: makeRunBeadsSyncMock({ exitCode: 0 }, () => {
          syncCalls += 1;
        }),
      },
    );
    expect(code).toBe(0);
    expect(bdCalls).toEqual([]);
    expect(syncCalls).toBe(0);
  });

  test("--apply with --from is rejected as mutually exclusive", async () => {
    const o = makeOutput();
    const code = await runTriageDriftFix(
      {
        apply: true,
        from: "/tmp/p.json",
        dryRun: false,
        limit: 0,
        axes: [...ALL_AXES],
        sync: true,
        ...DRIFT_FIX_DEFAULTS,
      },
      o.output,
      { ...STD_DEPS_BASE },
    );
    expect(code).toBe(1);
    expect(o.error.join("\n")).toMatch(/--apply and --from are mutually exclusive/);
  });
});

// GH-1342 — `runDriftFixActor` is the actor adapter for the triage state
// machine. It forces `apply: true` (regardless of the input `apply` field),
// captures stdout / stderr / audit lines, and projects counts so the
// machine's `driftFixing.onDone` can populate `context.driftFixResult`.
describe("runDriftFixActor — actor adapter (GH-1342)", () => {
  test("forces apply=true and projects writes/skips/errors + touchedIssues from audit", async () => {
    const bdCalls: Array<{ subcommand: string; args: string[] }> = [];
    let syncCalls = 0;
    const result = await runDriftFixActor(
      // Pass `apply: false` to confirm the adapter overrides it. `from` is
      // also cleared defensively — runTriageDriftFix would otherwise reject
      // `apply + from` as mutually exclusive.
      {
        apply: false,
        from: undefined,
        dryRun: false,
        limit: 0,
        axes: [...ALL_AXES],
        sync: true,
        ...DRIFT_FIX_DEFAULTS,
      },
      {
        ...STD_DEPS_BASE,
        listOpenIssues: () => [
          {
            number: 8,
            title: "stale",
            url: "https://github.com/bdelanghe/ai-home/issues/8",
            labels: [],
          },
        ],
        repoNameWithOwner: () => "bdelanghe/ai-home",
        loadAllBeads: () => [
          bead({
            id: "bd-8",
            title: "stale",
            status: "closed",
            externalRef: "https://github.com/bdelanghe/ai-home/issues/8",
            externalIssueNumber: 8,
          }),
        ],
        cwd: () => "/tmp/repo",
        // GH-296 / prx-ebo: writes via the daemon helpers.
        updateBead: async (id: string, fields: { issueType?: string; priority?: number }) => {
          const args = [id];
          if (fields.issueType !== undefined) args.push("--type", fields.issueType);
          if (fields.priority !== undefined) args.push("-p", String(fields.priority));
          bdCalls.push({ subcommand: "update", args });
          return null;
        },
        reopenBead: async (id: string) => {
          bdCalls.push({ subcommand: "reopen", args: [id] });
          return null;
        },
        auditSink: {
          stateDirOverride: "/tmp/state",
          ensureDir: () => {},
        },
        runBeadsSync: makeRunBeadsSyncMock({ exitCode: 0 }, () => {
          syncCalls += 1;
        }),
      },
    );

    expect(result.exitCode).toBe(0);
    // apply: true was forced — the reopen ran for the bd=closed/gh=open row.
    expect(bdCalls).toHaveLength(1);
    expect(bdCalls[0]!.subcommand).toBe("reopen");
    expect(result.writes).toBe(1);
    expect(result.skips).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.touchedIssues).toEqual([8]);
    expect(result.syncOutcome).toBe("ok");
    expect(syncCalls).toBe(1);
    // Audit shape: one update row + one sync row.
    const actions = result.audit.map((e) => e.action);
    expect(actions).toContain("update");
    expect(actions).toContain("sync");
  });

  test("no drift rows → exit 0, writes=0, syncOutcome='skipped'", async () => {
    const result = await runDriftFixActor(
      {
        apply: false,
        from: undefined,
        dryRun: false,
        limit: 0,
        axes: [...ALL_AXES],
        sync: true,
        ...DRIFT_FIX_DEFAULTS,
      },
      {
        ...STD_DEPS_BASE,
        listOpenIssues: () => [],
        repoNameWithOwner: () => "bdelanghe/ai-home",
        loadAllBeads: () => [],
        cwd: () => "/tmp/repo",
        execBd: () => ({ exitCode: 0, stdout: "", stderr: "", policy: null }),
        auditSink: {
          stateDirOverride: "/tmp/state",
          ensureDir: () => {},
        },
        runBeadsSync: makeRunBeadsSyncMock({ exitCode: 0 }),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.writes).toBe(0);
    expect(result.skips).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.touchedIssues).toEqual([]);
    expect(result.syncOutcome).toBe("skipped");
  });
});

// GH-1255 — `bd duplicates` + `bd merge` + `bd doctor` surfaces inside the
// drift-fix actor. Parity gate (priority + `area::*`) is the operator-
// confirmation substitute; `--doctor-fix` is opt-in only.
describe("runTriageDriftFix — GH-1255 dupe + doctor surfaces", () => {
  function dupeCluster(target: string, source: string): BdDuplicatesCluster {
    return {
      target: { beadsId: target, title: "stub", status: "open", priority: 2 },
      sources: [
        { beadsId: source, title: "stub", status: "open", priority: 2 },
      ],
    };
  }

  function fakeDupeRunner(
    clusters: BdDuplicatesCluster[],
  ): () => BdDuplicatesDryRunResult {
    return () => ({ exitCode: 0, clusters, stdout: "", stderr: "" });
  }

  function fakeDoctorRunner(
    total: number,
    fixable: number,
  ): () => BdDoctorResult {
    return () => ({
      exitCode: 0,
      report: {
        total,
        fixable,
        issues: total > 0
          ? [{ category: "orphans", count: total, fixable: fixable > 0 }]
          : [],
      },
      stdout: "",
      stderr: "",
    });
  }

  function gatherDupeAudit(audit: string[]): unknown[] {
    return audit.map((line) => JSON.parse(line));
  }

  // 1. Scan emits dupe clusters — parity ok, no merge calls in scan mode.
  test("scan emits dupe clusters and per-pair fix:dupe rows (parity ok)", async () => {
    const o = makeOutput();
    const code = await runTriageDriftFix(
      {
        apply: false,
        dryRun: false,
        limit: 0,
        axes: [...ALL_AXES],
        sync: true,
        ...DRIFT_FIX_DEFAULTS,
      },
      o.output,
      {
        ...STD_DEPS_BASE,
        listOpenIssues: () => [
          {
            number: 100,
            title: "twin",
            url: "https://github.com/bdelanghe/ai-home/issues/100",
            labels: [{ name: "area::prx" }],
          },
          {
            number: 101,
            title: "twin",
            url: "https://github.com/bdelanghe/ai-home/issues/101",
            labels: [{ name: "area::prx" }],
          },
        ],
        repoNameWithOwner: () => "bdelanghe/ai-home",
        loadAllBeads: () => [
          bead({ id: "bd-100", priority: 2, externalIssueNumber: 100 }),
          bead({ id: "bd-101", priority: 2, externalIssueNumber: 101 }),
        ],
        cwd: () => "/tmp/repo",
        runBdDuplicatesDryRun: fakeDupeRunner([dupeCluster("bd-100", "bd-101")]),
        runBdDoctorJson: fakeDoctorRunner(0, 0),
      },
    );
    expect(code).toBe(0);
    const plan = JSON.parse(o.log[0]!) as DriftFixPlan;
    expect(plan.duplicates).toHaveLength(1);
    const dupeRows = plan.rows.filter((r) => r.decision === "fix:dupe");
    expect(dupeRows).toHaveLength(1);
    expect(dupeRows[0]!.dupe).toBeDefined();
    expect(dupeRows[0]!.dupe?.target).toBe("bd-100");
    expect(dupeRows[0]!.dupe?.source).toBe("bd-101");
    expect(dupeRows[0]!.dupe?.parityOk).toBe(true);
  });

  // 2. Parity-mismatch row — priority differs across the cluster.
  test("parity-mismatch row emits parityOk=false with priority reason", async () => {
    const o = makeOutput();
    const code = await runTriageDriftFix(
      {
        apply: false,
        dryRun: false,
        limit: 0,
        axes: [...ALL_AXES],
        sync: true,
        ...DRIFT_FIX_DEFAULTS,
      },
      o.output,
      {
        ...STD_DEPS_BASE,
        listOpenIssues: () => [
          {
            number: 200,
            title: "twin",
            url: "https://github.com/bdelanghe/ai-home/issues/200",
            labels: [{ name: "area::prx" }],
          },
          {
            number: 201,
            title: "twin",
            url: "https://github.com/bdelanghe/ai-home/issues/201",
            labels: [{ name: "area::prx" }],
          },
        ],
        repoNameWithOwner: () => "bdelanghe/ai-home",
        loadAllBeads: () => [
          bead({ id: "bd-200", priority: 2, externalIssueNumber: 200 }),
          bead({ id: "bd-201", priority: 1, externalIssueNumber: 201 }),
        ],
        cwd: () => "/tmp/repo",
        runBdDuplicatesDryRun: fakeDupeRunner([dupeCluster("bd-200", "bd-201")]),
        runBdDoctorJson: fakeDoctorRunner(0, 0),
      },
    );
    expect(code).toBe(0);
    const plan = JSON.parse(o.log[0]!) as DriftFixPlan;
    const dupeRow = plan.rows.find((r) => r.decision === "fix:dupe");
    expect(dupeRow?.dupe?.parityOk).toBe(false);
    expect(dupeRow?.dupe?.parityReason).toMatch(/priority/);
  });

  // 3. Parity-ok cluster with --apply runs bd merge.
  test("parity-ok cluster with --apply runs bd merge and writes audit", async () => {
    const audit: string[] = [];
    const mergeCalls: BdMergeOptions[] = [];
    const fakeMerge = (mergeOpts: BdMergeOptions): BdMergeResult => {
      mergeCalls.push(mergeOpts);
      return {
        exitCode: 0,
        result: { target: mergeOpts.target, sources: mergeOpts.sources, applied: true },
        stdout: "",
        stderr: "",
      };
    };
    const result = await runDriftFixActor(
      {
        apply: true,
        dryRun: false,
        limit: 0,
        axes: [...ALL_AXES],
        sync: false,
        ...DRIFT_FIX_DEFAULTS,
      },
      {
        ...STD_DEPS_BASE,
        listOpenIssues: () => [
          {
            number: 300,
            title: "twin",
            url: "https://github.com/bdelanghe/ai-home/issues/300",
            labels: [{ name: "area::prx" }],
          },
          {
            number: 301,
            title: "twin",
            url: "https://github.com/bdelanghe/ai-home/issues/301",
            labels: [{ name: "area::prx" }],
          },
        ],
        repoNameWithOwner: () => "bdelanghe/ai-home",
        loadAllBeads: () => [
          bead({ id: "bd-300", priority: 2, externalIssueNumber: 300 }),
          bead({ id: "bd-301", priority: 2, externalIssueNumber: 301 }),
        ],
        cwd: () => "/tmp/repo",
        execBd: () => ({ exitCode: 0, stdout: "", stderr: "", policy: null }),
        runBdDuplicatesDryRun: fakeDupeRunner([dupeCluster("bd-300", "bd-301")]),
        runBdDoctorJson: fakeDoctorRunner(0, 0),
        runBdMerge: fakeMerge,
        auditSink: {
          stateDirOverride: "/tmp/state",
          ensureDir: () => {},
          appendFn: (_path: string, line: string) => audit.push(line),
        },
        runBeadsSync: makeRunBeadsSyncMock({ exitCode: 0 }),
      },
    );
    expect(mergeCalls).toHaveLength(1);
    expect(mergeCalls[0]!.target).toBe("bd-300");
    expect(mergeCalls[0]!.sources).toEqual(["bd-301"]);
    expect(mergeCalls[0]!.dryRun).toBe(false);
    const mergeEntry = gatherDupeAudit(audit).find(
      (e) => (e as { action: string }).action === "dupe-merge",
    ) as { applied: boolean; parityOk: boolean };
    expect(mergeEntry.applied).toBe(true);
    expect(mergeEntry.parityOk).toBe(true);
    expect(result.mergesApplied).toBe(1);
  });

  // 4. Parity-mismatch with --apply skips bd merge.
  test("parity-mismatch with --apply skips bd merge, counts skipped-parity", async () => {
    const audit: string[] = [];
    let mergeCalls = 0;
    const result = await runDriftFixActor(
      {
        apply: true,
        dryRun: false,
        limit: 0,
        axes: [...ALL_AXES],
        sync: false,
        ...DRIFT_FIX_DEFAULTS,
      },
      {
        ...STD_DEPS_BASE,
        listOpenIssues: () => [
          {
            number: 400,
            title: "twin",
            url: "https://github.com/bdelanghe/ai-home/issues/400",
            labels: [{ name: "area::prx" }],
          },
          {
            number: 401,
            title: "twin",
            url: "https://github.com/bdelanghe/ai-home/issues/401",
            labels: [{ name: "area::beads" }],
          },
        ],
        repoNameWithOwner: () => "bdelanghe/ai-home",
        loadAllBeads: () => [
          bead({ id: "bd-400", priority: 2, externalIssueNumber: 400 }),
          bead({ id: "bd-401", priority: 2, externalIssueNumber: 401 }),
        ],
        cwd: () => "/tmp/repo",
        execBd: () => ({ exitCode: 0, stdout: "", stderr: "", policy: null }),
        runBdDuplicatesDryRun: fakeDupeRunner([dupeCluster("bd-400", "bd-401")]),
        runBdDoctorJson: fakeDoctorRunner(0, 0),
        runBdMerge: () => {
          mergeCalls += 1;
          return {
            exitCode: 0,
            result: { target: "x", sources: ["y"], applied: true },
            stdout: "",
            stderr: "",
          };
        },
        auditSink: {
          stateDirOverride: "/tmp/state",
          ensureDir: () => {},
          appendFn: (_path: string, line: string) => audit.push(line),
        },
        runBeadsSync: makeRunBeadsSyncMock({ exitCode: 0 }),
      },
    );
    expect(mergeCalls).toBe(0);
    const mergeEntry = gatherDupeAudit(audit).find(
      (e) => (e as { action: string }).action === "dupe-merge",
    ) as { applied: boolean; parityOk: boolean };
    expect(mergeEntry.applied).toBe(false);
    expect(mergeEntry.parityOk).toBe(false);
    expect(result.mergesApplied).toBe(0);
    expect(result.mergesSkippedParity).toBe(1);
  });

  // 5. Doctor surface without --fix.
  test("doctor surfaces health without --fix (read-only)", async () => {
    const audit: string[] = [];
    let fixCalls = 0;
    const result = await runDriftFixActor(
      {
        apply: true,
        dryRun: false,
        limit: 0,
        axes: [...ALL_AXES],
        sync: false,
        ...DRIFT_FIX_DEFAULTS,
      },
      {
        ...STD_DEPS_BASE,
        listOpenIssues: () => [],
        repoNameWithOwner: () => "bdelanghe/ai-home",
        loadAllBeads: () => [],
        cwd: () => "/tmp/repo",
        execBd: () => ({ exitCode: 0, stdout: "", stderr: "", policy: null }),
        runBdDuplicatesDryRun: fakeDupeRunner([]),
        runBdDoctorJson: fakeDoctorRunner(3, 2),
        runBdDoctorFix: () => {
          fixCalls += 1;
          return {
            exitCode: 0,
            report: { total: 0, fixable: 0, issues: [] },
            stdout: "",
            stderr: "",
          };
        },
        auditSink: {
          stateDirOverride: "/tmp/state",
          ensureDir: () => {},
          appendFn: (_path: string, line: string) => audit.push(line),
        },
        runBeadsSync: makeRunBeadsSyncMock({ exitCode: 0 }),
      },
    );
    expect(fixCalls).toBe(0);
    const doctorEntries = gatherDupeAudit(audit).filter(
      (e) => (e as { action: string }).action === "doctor-health",
    ) as Array<{ applied: boolean; total: number; fixable: number }>;
    expect(doctorEntries).toHaveLength(1);
    expect(doctorEntries[0]!.applied).toBe(false);
    expect(doctorEntries[0]!.total).toBe(3);
    expect(doctorEntries[0]!.fixable).toBe(2);
    expect(result.substrateHealth.total).toBe(3);
    expect(result.substrateHealth.fixable).toBe(2);
    expect(result.substrateHealth.fixed).toBe(false);
  });

  // 6. --doctor-fix runs the fix and emits a second doctor-health row.
  test("--doctor-fix runs the fix and emits a second doctor-health row", async () => {
    const audit: string[] = [];
    let fixCalls = 0;
    const result = await runDriftFixActor(
      {
        apply: true,
        dryRun: false,
        limit: 0,
        axes: [...ALL_AXES],
        sync: false,
        ...DRIFT_FIX_DEFAULTS,
        doctorFix: true,
      },
      {
        ...STD_DEPS_BASE,
        listOpenIssues: () => [],
        repoNameWithOwner: () => "bdelanghe/ai-home",
        loadAllBeads: () => [],
        cwd: () => "/tmp/repo",
        execBd: () => ({ exitCode: 0, stdout: "", stderr: "", policy: null }),
        runBdDuplicatesDryRun: fakeDupeRunner([]),
        runBdDoctorJson: fakeDoctorRunner(3, 2),
        runBdDoctorFix: () => {
          fixCalls += 1;
          return {
            exitCode: 0,
            report: { total: 1, fixable: 0, issues: [] },
            stdout: "",
            stderr: "",
          };
        },
        auditSink: {
          stateDirOverride: "/tmp/state",
          ensureDir: () => {},
          appendFn: (_path: string, line: string) => audit.push(line),
        },
        runBeadsSync: makeRunBeadsSyncMock({ exitCode: 0 }),
      },
    );
    expect(fixCalls).toBe(1);
    const doctorEntries = gatherDupeAudit(audit).filter(
      (e) => (e as { action: string }).action === "doctor-health",
    ) as Array<{ applied: boolean; total: number; fixable: number }>;
    expect(doctorEntries).toHaveLength(2);
    expect(doctorEntries[0]!.applied).toBe(false);
    expect(doctorEntries[1]!.applied).toBe(true);
    expect(result.substrateHealth.fixed).toBe(true);
  });

  // 6b. Parity-ok cluster but --no-apply-dupes ⇒ surfaced + skipped, no merge.
  // Driven through `runTriageDriftFix` directly: `runDriftFixActor` force-sets
  // `applyDupes: true`, so the disabled path is only reachable on the raw verb.
  test("parity-ok cluster with applyDupes=false skips the merge (apply-dupes-disabled)", async () => {
    const audit: string[] = [];
    const o = makeOutput();
    let mergeCalls = 0;
    const code = await runTriageDriftFix(
      {
        apply: true,
        dryRun: false,
        limit: 0,
        axes: [...ALL_AXES],
        sync: false,
        ...DRIFT_FIX_DEFAULTS,
        applyDupes: false,
      },
      o.output,
      {
        ...STD_DEPS_BASE,
        listOpenIssues: () => [
          { number: 600, title: "twin", url: "https://github.com/bdelanghe/ai-home/issues/600", labels: [{ name: "area::prx" }] },
          { number: 601, title: "twin", url: "https://github.com/bdelanghe/ai-home/issues/601", labels: [{ name: "area::prx" }] },
        ],
        repoNameWithOwner: () => "bdelanghe/ai-home",
        loadAllBeads: () => [
          bead({ id: "bd-600", priority: 2, externalIssueNumber: 600 }),
          bead({ id: "bd-601", priority: 2, externalIssueNumber: 601 }),
        ],
        cwd: () => "/tmp/repo",
        execBd: () => ({ exitCode: 0, stdout: "", stderr: "", policy: null }),
        runBdDuplicatesDryRun: fakeDupeRunner([dupeCluster("bd-600", "bd-601")]),
        runBdDoctorJson: fakeDoctorRunner(0, 0),
        runBdMerge: () => {
          mergeCalls += 1;
          return { exitCode: 0, result: { target: "x", sources: ["y"], applied: true }, stdout: "", stderr: "" };
        },
        auditSink: {
          stateDirOverride: "/tmp/state",
          ensureDir: () => {},
          appendFn: (_path: string, line: string) => audit.push(line),
        },
        runBeadsSync: makeRunBeadsSyncMock({ exitCode: 0 }),
      },
    );
    expect(code).toBe(0);
    expect(mergeCalls).toBe(0);
    const mergeEntry = gatherDupeAudit(audit).find(
      (e) => (e as { action: string }).action === "dupe-merge",
    ) as { applied: boolean; parityOk: boolean; reason?: string };
    expect(mergeEntry.applied).toBe(false);
    expect(mergeEntry.parityOk).toBe(true);
    expect(mergeEntry.reason).toBe("apply-dupes-disabled");
    expect(o.log.some((l) => l.includes("apply-dupes-disabled"))).toBe(true);
  });

  // 6c. Real `bd merge` exec fails ⇒ error entry, errors counted, exit 1.
  test("parity-ok cluster whose bd merge fails ⇒ error entry + exit 1", async () => {
    const audit: string[] = [];
    const result = await runDriftFixActor(
      {
        apply: true,
        dryRun: false,
        limit: 0,
        axes: [...ALL_AXES],
        sync: false,
        ...DRIFT_FIX_DEFAULTS,
      },
      {
        ...STD_DEPS_BASE,
        listOpenIssues: () => [
          { number: 700, title: "twin", url: "https://github.com/bdelanghe/ai-home/issues/700", labels: [{ name: "area::prx" }] },
          { number: 701, title: "twin", url: "https://github.com/bdelanghe/ai-home/issues/701", labels: [{ name: "area::prx" }] },
        ],
        repoNameWithOwner: () => "bdelanghe/ai-home",
        loadAllBeads: () => [
          bead({ id: "bd-700", priority: 2, externalIssueNumber: 700 }),
          bead({ id: "bd-701", priority: 2, externalIssueNumber: 701 }),
        ],
        cwd: () => "/tmp/repo",
        execBd: () => ({ exitCode: 0, stdout: "", stderr: "", policy: null }),
        runBdDuplicatesDryRun: fakeDupeRunner([dupeCluster("bd-700", "bd-701")]),
        runBdDoctorJson: fakeDoctorRunner(0, 0),
        runBdMerge: () => ({ exitCode: 2, result: null, stdout: "", stderr: "merge conflict" }),
        auditSink: {
          stateDirOverride: "/tmp/state",
          ensureDir: () => {},
          appendFn: (_path: string, line: string) => audit.push(line),
        },
        runBeadsSync: makeRunBeadsSyncMock({ exitCode: 0 }),
      },
    );
    // A failed `bd merge` raises the internal error counter (→ exit 1) but is
    // recorded as a `dupe-merge` audit row, not an `error` row, so the actor's
    // audit-projected `errors` total stays 0.
    expect(result.exitCode).toBe(1);
    expect(result.mergesApplied).toBe(0);
    const mergeEntry = gatherDupeAudit(audit).find(
      (e) => (e as { action: string }).action === "dupe-merge",
    ) as { applied: boolean; exitCode: number; stderr?: string };
    expect(mergeEntry.applied).toBe(false);
    expect(mergeEntry.exitCode).toBe(2);
    expect(mergeEntry.stderr).toContain("merge conflict");
  });

  // 6d. --doctor-fix whose `bd doctor --fix` exec fails ⇒ error + exit 1.
  test("--doctor-fix failure emits an error doctor-health row and exits 1", async () => {
    const audit: string[] = [];
    const result = await runDriftFixActor(
      {
        apply: true,
        dryRun: false,
        limit: 0,
        axes: [...ALL_AXES],
        sync: false,
        ...DRIFT_FIX_DEFAULTS,
        doctorFix: true,
      },
      {
        ...STD_DEPS_BASE,
        listOpenIssues: () => [],
        repoNameWithOwner: () => "bdelanghe/ai-home",
        loadAllBeads: () => [],
        cwd: () => "/tmp/repo",
        execBd: () => ({ exitCode: 0, stdout: "", stderr: "", policy: null }),
        runBdDuplicatesDryRun: fakeDupeRunner([]),
        runBdDoctorJson: fakeDoctorRunner(3, 2),
        runBdDoctorFix: () => ({ exitCode: 1, report: { total: 0, fixable: 0, issues: [] }, stdout: "", stderr: "doctor --fix blew up" }),
        auditSink: {
          stateDirOverride: "/tmp/state",
          ensureDir: () => {},
          appendFn: (_path: string, line: string) => audit.push(line),
        },
        runBeadsSync: makeRunBeadsSyncMock({ exitCode: 0 }),
      },
    );
    // The failed `bd doctor --fix` raises the internal error counter (→ exit 1)
    // but is recorded as a `doctor-health` audit row, not an `error` row.
    expect(result.exitCode).toBe(1);
    const doctorEntries = gatherDupeAudit(audit).filter(
      (e) => (e as { action: string }).action === "doctor-health",
    ) as Array<{ applied: boolean; exitCode: number; stderr?: string }>;
    expect(doctorEntries).toHaveLength(2);
    const failed = doctorEntries[1]!;
    expect(failed.applied).toBe(false);
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain("doctor --fix blew up");
  });

  // 7. Machine actor: dupes on, doctor-fix off — mirrors `prx triage prime
  // --auto-drift-fix` default per GH-1342.
  test("machine actor default: dupes apply, doctor-fix never runs", async () => {
    let fixCalls = 0;
    const mergeCalls: BdMergeOptions[] = [];
    await runDriftFixActor(
      {
        apply: true,
        dryRun: false,
        limit: 0,
        axes: [...ALL_AXES],
        sync: false,
        ...DRIFT_FIX_DEFAULTS,
      },
      {
        ...STD_DEPS_BASE,
        listOpenIssues: () => [
          {
            number: 500,
            title: "twin",
            url: "https://github.com/bdelanghe/ai-home/issues/500",
            labels: [{ name: "area::prx" }],
          },
          {
            number: 501,
            title: "twin",
            url: "https://github.com/bdelanghe/ai-home/issues/501",
            labels: [{ name: "area::prx" }],
          },
        ],
        repoNameWithOwner: () => "bdelanghe/ai-home",
        loadAllBeads: () => [
          bead({ id: "bd-500", priority: 2, externalIssueNumber: 500 }),
          bead({ id: "bd-501", priority: 2, externalIssueNumber: 501 }),
        ],
        cwd: () => "/tmp/repo",
        execBd: () => ({ exitCode: 0, stdout: "", stderr: "", policy: null }),
        runBdDuplicatesDryRun: fakeDupeRunner([dupeCluster("bd-500", "bd-501")]),
        runBdDoctorJson: fakeDoctorRunner(3, 2),
        runBdMerge: (mergeOpts) => {
          mergeCalls.push(mergeOpts);
          return {
            exitCode: 0,
            result: { target: mergeOpts.target, sources: mergeOpts.sources, applied: true },
            stdout: "",
            stderr: "",
          };
        },
        runBdDoctorFix: () => {
          fixCalls += 1;
          return {
            exitCode: 0,
            report: { total: 0, fixable: 0, issues: [] },
            stdout: "",
            stderr: "",
          };
        },
        runBeadsSync: makeRunBeadsSyncMock({ exitCode: 0 }),
      },
    );
    expect(mergeCalls).toHaveLength(1);
    expect(fixCalls).toBe(0);
  });

  // 8. --no-dupes / --no-doctor opt-out.
  test("includeDupes=false skips dupe scan, includeDoctor=false skips doctor", async () => {
    let dupeCalls = 0;
    let doctorCalls = 0;
    const o = makeOutput();
    await runTriageDriftFix(
      {
        apply: false,
        dryRun: false,
        limit: 0,
        axes: [...ALL_AXES],
        sync: true,
        ...DRIFT_FIX_DEFAULTS,
        includeDupes: false,
        includeDoctor: false,
      },
      o.output,
      {
        ...STD_DEPS_BASE,
        listOpenIssues: () => [],
        repoNameWithOwner: () => "bdelanghe/ai-home",
        loadAllBeads: () => [],
        cwd: () => "/tmp/repo",
        runBdDuplicatesDryRun: () => {
          dupeCalls += 1;
          return { exitCode: 0, clusters: [], stdout: "", stderr: "" };
        },
        runBdDoctorJson: () => {
          doctorCalls += 1;
          return {
            exitCode: 0,
            report: { total: 0, fixable: 0, issues: [] },
            stdout: "",
            stderr: "",
          };
        },
      },
    );
    expect(dupeCalls).toBe(0);
    expect(doctorCalls).toBe(0);
    const plan = JSON.parse(o.log[0]!) as DriftFixPlan;
    expect(plan.duplicates).toEqual([]);
    expect(plan.substrateHealth).toEqual({ total: 0, fixable: 0, issues: [] });
  });

  // 9. Plan-replay path carries dupe rows without re-querying bd.
  test("plan-replay path honors plan.dupe.parityOk without re-querying bd", async () => {
    const audit: string[] = [];
    let dupeCalls = 0;
    const mergeCalls: BdMergeOptions[] = [];
    const planJson: DriftFixPlan = {
      repo: "bdelanghe/ai-home",
      generatedAt: NOW.toISOString(),
      rows: [
        {
          issueNumber: 0,
          beadsId: "bd-601",
          decision: "fix:dupe",
          reason: "bd-duplicate of bd-600 (parity ok)",
          dupe: {
            target: "bd-600",
            source: "bd-601",
            parityOk: true,
            parityReason: null,
          },
        },
      ],
      duplicates: [],
      substrateHealth: { total: 0, fixable: 0, issues: [] },
    };
    const o = makeOutput();
    const code = await runTriageDriftFix(
      {
        from: "/tmp/p.json",
        apply: false,
        dryRun: false,
        limit: 0,
        axes: [...ALL_AXES],
        sync: false,
        ...DRIFT_FIX_DEFAULTS,
      },
      o.output,
      {
        ...STD_DEPS_BASE,
        readFileSync: () => JSON.stringify(planJson),
        loadAllBeads: () => [],
        runBdDuplicatesDryRun: () => {
          dupeCalls += 1;
          return { exitCode: 0, clusters: [], stdout: "", stderr: "" };
        },
        runBdMerge: (mergeOpts) => {
          mergeCalls.push(mergeOpts);
          return {
            exitCode: 0,
            result: { target: mergeOpts.target, sources: mergeOpts.sources, applied: true },
            stdout: "",
            stderr: "",
          };
        },
        auditSink: {
          stateDirOverride: "/tmp/state",
          ensureDir: () => {},
          appendFn: (_path: string, line: string) => audit.push(line),
        },
      },
    );
    expect(code).toBe(0);
    // Replay path must not re-run the dupe scan — plan is authoritative.
    expect(dupeCalls).toBe(0);
    expect(mergeCalls).toHaveLength(1);
    expect(mergeCalls[0]!.target).toBe("bd-600");
    expect(mergeCalls[0]!.sources).toEqual(["bd-601"]);
  });
});
