import { describe, expect, test } from "bun:test";

import {
  buildPromotePlan,
  runTriagePromote,
  selectDecision,
  type PromotePlan,
  type PromotePlanRow,
} from "../../src/triage/promote.ts";
import type { BdExecResult } from "@bounded-systems/bd";
import type { GhExecResult } from "@bounded-systems/gh";
import type { BeadsRecord } from "../../src/triage/triage.ts";
import type { FallbackIssue } from "../../src/pr-state/github.ts";

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

function bead(overrides: Partial<BeadsRecord> = {}): BeadsRecord {
  return {
    id: "bd-001",
    title: "stub",
    description: "",
    status: "open",
    priority: 2,
    issueType: "task",
    externalRef: null,
    externalRefs: {},
    metadata: null,
    externalIssueNumber: null,
    sourceSystem: null,
    ...overrides,
  };
}

function planFixture(rows: PromotePlanRow[]): PromotePlan {
  return {
    repo: "bdelanghe/ai-home",
    generatedAt: "2026-04-29T00:00:00.000Z",
    rows,
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

describe("selectDecision", () => {
  const emptyLookup = { byUrl: new Map(), byIssueNumber: new Map(), byDomainExternalId: new Map() };

  test("skip:missing-labels when no type::*", () => {
    const row = selectDecision(issue({ labels: [ghLabel("priority::medium")] }), emptyLookup);
    expect(row.decision).toBe("skip:missing-labels");
    expect(row.type).toBeUndefined();
    expect(row.reason).toMatch(/no type/);
  });

  test("skip:missing-labels when type set but priority absent", () => {
    const row = selectDecision(issue({ labels: [ghLabel("type::bug")] }), emptyLookup);
    expect(row.decision).toBe("skip:missing-labels");
    expect(row.type).toBe("bug");
    expect(row.priority).toBeUndefined();
  });

  test("skip:missing-labels when multiple priority::* labels", () => {
    const row = selectDecision(
      issue({
        labels: [ghLabel("type::bug"), ghLabel("priority::high"), ghLabel("priority::low")],
      }),
      emptyLookup,
    );
    expect(row.decision).toBe("skip:missing-labels");
    expect(row.reason).toMatch(/ambiguous priority/);
  });

  test("skip:non-execution-type for epic", () => {
    const row = selectDecision(
      issue({
        labels: [ghLabel("type::epic"), ghLabel("priority::low")],
      }),
      emptyLookup,
    );
    expect(row.decision).toBe("skip:non-execution-type");
    expect(row.reason).toMatch(/epic/);
  });

  test("skip:already-in-bd via URL match", () => {
    const url = "https://github.com/bdelanghe/ai-home/issues/100";
    const lookup = {
      byUrl: new Map([[url.toLowerCase(), bead({ id: "bd-042", externalRef: url })]]),
      byIssueNumber: new Map<number, BeadsRecord>(),
      byDomainExternalId: new Map<string, Map<string, BeadsRecord>>(),
    };
    const row = selectDecision(
      issue({
        url,
        labels: [ghLabel("type::feature"), ghLabel("priority::medium")],
      }),
      lookup,
    );
    expect(row.decision).toBe("skip:already-in-bd");
    expect(row.reason).toMatch(/bd-042/);
  });

  test("skip:already-in-bd via legacy issue-number index", () => {
    const lookup = {
      byUrl: new Map<string, BeadsRecord>(),
      byIssueNumber: new Map([[100, bead({ id: "bd-099", externalIssueNumber: 100 })]]),
      byDomainExternalId: new Map<string, Map<string, BeadsRecord>>(),
    };
    const row = selectDecision(
      issue({
        labels: [ghLabel("type::task"), ghLabel("priority::medium")],
      }),
      lookup,
    );
    expect(row.decision).toBe("skip:already-in-bd");
  });

  test("promote when execution-ready type + priority + not in bd", () => {
    const row = selectDecision(
      issue({
        labels: [ghLabel("type::bug"), ghLabel("priority::high")],
      }),
      { byUrl: new Map(), byIssueNumber: new Map(), byDomainExternalId: new Map() },
    );
    expect(row.decision).toBe("promote");
    expect(row.type).toBe("bug");
    expect(row.priority).toBe("high");
  });

  test("promote covers all four execution-ready types", () => {
    for (const t of ["bug", "feature", "task", "chore"] as const) {
      const row = selectDecision(
        issue({
          labels: [ghLabel(`type::${t}`), ghLabel("priority::medium")],
        }),
        { byUrl: new Map(), byIssueNumber: new Map(), byDomainExternalId: new Map() },
      );
      expect(row.decision).toBe("promote");
    }
  });
});

describe("buildPromotePlan (Phase 1 scan)", () => {
  test("groups decisions across a mixed input", () => {
    const issues: FallbackIssue[] = [
      issue({
        number: 1,
        url: "https://github.com/bdelanghe/ai-home/issues/1",
        labels: [ghLabel("type::bug"), ghLabel("priority::high")],
      }),
      issue({
        number: 2,
        url: "https://github.com/bdelanghe/ai-home/issues/2",
        labels: [ghLabel("type::epic"), ghLabel("priority::medium")],
      }),
      issue({
        number: 3,
        url: "https://github.com/bdelanghe/ai-home/issues/3",
        labels: [ghLabel("type::feature")],
      }),
      issue({
        number: 4,
        url: "https://github.com/bdelanghe/ai-home/issues/4",
        labels: [ghLabel("type::task"), ghLabel("priority::medium")],
      }),
    ];
    const beads: BeadsRecord[] = [
      bead({
        id: "bd-019",
        externalRef: "https://github.com/bdelanghe/ai-home/issues/4",
        externalIssueNumber: 4,
      }),
    ];
    const plan = buildPromotePlan(issues, beads, "bdelanghe/ai-home", "2026-04-29T00:00:00Z");
    expect(plan.rows).toHaveLength(4);
    const decisions = plan.rows.map((r) => `${r.number}:${r.decision}`);
    expect(decisions).toEqual([
      "1:promote",
      "2:skip:non-execution-type",
      "3:skip:missing-labels",
      "4:skip:already-in-bd",
    ]);
  });
});

describe("runTriagePromote — scan phase", () => {
  test("emits a JSON plan to stdout when --from is omitted", () => {
    const o = makeOutput();
    const code = runTriagePromote({ dryRun: false, limit: 0 }, o.output, {
      ...STD_DEPS_BASE,
      listOpenIssues: () => [
        issue({
          number: 7,
          url: "https://github.com/bdelanghe/ai-home/issues/7",
          labels: [ghLabel("type::feature"), ghLabel("priority::medium")],
        }),
      ],
      repoNameWithOwner: () => "bdelanghe/ai-home",
      loadAllBeads: () => [],
      cwd: () => "/tmp/repo",
    });
    expect(code).toBe(0);
    expect(o.log).toHaveLength(1);
    const plan = JSON.parse(o.log[0]!) as PromotePlan;
    expect(plan.repo).toBe("bdelanghe/ai-home");
    expect(plan.rows[0]!.decision).toBe("promote");
  });
});

describe("runTriagePromote — apply phase", () => {
  function setup(
    rows: PromotePlanRow[],
    options: {
      bdResults?: BdExecResult[];
      ghResults?: GhExecResult[];
      beadsAtApply?: BeadsRecord[];
    } = {},
  ) {
    const audit: string[] = [];
    let bdIndex = 0;
    let ghIndex = 0;
    const bdResults = options.bdResults ?? [];
    const ghResults = options.ghResults ?? [];
    const execBd = () => {
      const result = bdResults[bdIndex] ?? {
        exitCode: 0,
        stdout: `bd-${1000 + bdIndex}`,
        stderr: "",
        policy: null,
      };
      bdIndex += 1;
      return result;
    };
    // GH-296 / prx-82b: create runs `prx beads create …` through the daemon (a
    // sync runner) which echoes the record as JSON. Wrap the bdResults' raw id
    // stdout as the JSON record the new code parses; consume the same queue.
    const run = (_cmd: string[]) => {
      const result = bdResults[bdIndex] ?? {
        exitCode: 0,
        stdout: `bd-${1000 + bdIndex}`,
        stderr: "",
        policy: null,
      };
      bdIndex += 1;
      const idRaw = result.stdout.trim();
      const stdout =
        result.exitCode === 0 ? JSON.stringify(idRaw.length > 0 ? { id: idRaw } : {}) : "";
      return { status: result.exitCode, stdout, stderr: result.stderr };
    };
    const execGh = () => {
      const result = ghResults[ghIndex] ?? {
        exitCode: 0,
        stdout: "",
        stderr: "",
        policy: null,
      };
      ghIndex += 1;
      return result;
    };
    const fixture = JSON.stringify(planFixture(rows));
    const o = makeOutput();
    const deps = {
      ...STD_DEPS_BASE,
      execBd,
      run,
      execGh,
      readFileSync: () => fixture,
      loadAllBeads: () => options.beadsAtApply ?? [],
      auditSink: {
        ...STD_DEPS_BASE.auditSink,
        appendFn: (_path: string, line: string) => audit.push(line),
      },
    };
    return {
      audit,
      o,
      deps,
      bdCalls: () => bdIndex,
      ghCalls: () => ghIndex,
    };
  }

  function promoteRow(overrides: Partial<PromotePlanRow> = {}): PromotePlanRow {
    return {
      number: 42,
      url: "https://github.com/bdelanghe/ai-home/issues/42",
      title: "feat: thing",
      type: "feature",
      priority: "medium",
      decision: "promote",
      reason: "execution-ready type with both axes set",
      ...overrides,
    };
  }

  test("dry-run writes audit entries and skips both bd and gh", () => {
    const { audit, o, deps, bdCalls, ghCalls } = setup([promoteRow()]);
    const code = runTriagePromote({ from: "/tmp/p.json", dryRun: true, limit: 0 }, o.output, deps);
    expect(code).toBe(0);
    expect(bdCalls()).toBe(0);
    expect(ghCalls()).toBe(0);
    expect(audit).toHaveLength(1);
    const entry = JSON.parse(audit[0]!);
    expect(entry.action).toBe("create");
    expect(entry.dryRun).toBe(true);
    expect(entry.beadId).toBeUndefined();
  });

  test("non-promote rows are skipped without writes", () => {
    const { audit, o, deps, bdCalls, ghCalls } = setup([
      promoteRow({ number: 1, decision: "skip:missing-labels", reason: "no type" }),
      promoteRow({ number: 2, decision: "skip:non-execution-type", reason: "epic" }),
      promoteRow({ number: 3, decision: "skip:already-in-bd", reason: "bd-1" }),
    ]);
    const code = runTriagePromote({ from: "/tmp/p.json", dryRun: false, limit: 0 }, o.output, deps);
    expect(code).toBe(0);
    expect(bdCalls()).toBe(0);
    expect(ghCalls()).toBe(0);
    expect(audit).toHaveLength(3);
    for (const line of audit) {
      const entry = JSON.parse(line);
      expect(entry.action).toBe("skip");
    }
  });

  test("promote row creates bd row, posts gh comment, captures bead id", () => {
    const bdCalls: Array<{ args: string[] }> = [];
    const ghCalls: Array<{ args: string[] }> = [];
    const fixture = JSON.stringify(planFixture([promoteRow()]));
    const audit: string[] = [];
    const o = makeOutput();
    const code = runTriagePromote({ from: "/tmp/p.json", dryRun: false, limit: 0 }, o.output, {
      ...STD_DEPS_BASE,
      run: ((cmd: string[]) => {
        bdCalls.push({ args: cmd.slice(3) });
        return { status: 0, stdout: JSON.stringify({ id: "bd-9000" }), stderr: "" };
      }) as never,
      execGh: (opts) => {
        ghCalls.push({ args: opts.args });
        return { exitCode: 0, stdout: "", stderr: "", policy: null };
      },
      readFileSync: () => fixture,
      loadAllBeads: () => [],
      auditSink: {
        stateDirOverride: "/tmp/state",
        ensureDir: () => {},
        appendFn: (_path: string, line: string) => audit.push(line),
      },
    });
    expect(code).toBe(0);
    expect(bdCalls).toHaveLength(1);
    expect(bdCalls[0]!.args).toContain("--external-ref");
    expect(bdCalls[0]!.args).toContain("https://github.com/bdelanghe/ai-home/issues/42");
    expect(bdCalls[0]!.args).toContain("--type");
    expect(bdCalls[0]!.args).toContain("feature");
    expect(bdCalls[0]!.args).toContain("--priority");
    expect(bdCalls[0]!.args).toContain("2");
    expect(ghCalls).toHaveLength(1);
    expect(ghCalls[0]!.args).toContain("42");
    expect(ghCalls[0]!.args).toContain("--body");
    expect(ghCalls[0]!.args).toContain("Promoted to beads as bd-9000.");
    expect(ghCalls[0]!.args).toContain("--repo");
    expect(ghCalls[0]!.args).toContain("bdelanghe/ai-home");
    const entry = JSON.parse(audit[0]!);
    expect(entry.action).toBe("create");
    expect(entry.beadId).toBe("bd-9000");
  });

  test("priority maps critical→0, high→1, medium→2, low→3", () => {
    const cases: Array<["critical" | "high" | "medium" | "low", string]> = [
      ["critical", "0"],
      ["high", "1"],
      ["medium", "2"],
      ["low", "3"],
    ];
    for (const [label, expected] of cases) {
      const captured: Array<{ args: string[] }> = [];
      const fixture = JSON.stringify(planFixture([promoteRow({ priority: label })]));
      const o = makeOutput();
      runTriagePromote({ from: "/tmp/p.json", dryRun: false, limit: 0 }, o.output, {
        ...STD_DEPS_BASE,
        run: ((cmd: string[]) => {
          captured.push({ args: cmd.slice(3) });
          return { status: 0, stdout: JSON.stringify({ id: "bd-1" }), stderr: "" };
        }) as never,
        execGh: () => ({ exitCode: 0, stdout: "", stderr: "", policy: null }),
        readFileSync: () => fixture,
        loadAllBeads: () => [],
        auditSink: {
          stateDirOverride: "/tmp/state",
          ensureDir: () => {},
          appendFn: () => {},
        },
      });
      const idx = captured[0]!.args.indexOf("--priority");
      expect(captured[0]!.args[idx + 1]).toBe(expected);
    }
  });

  test("--only filters the plan to a single issue number", () => {
    const { audit, o, deps } = setup([
      promoteRow({ number: 1 }),
      promoteRow({ number: 2 }),
      promoteRow({ number: 3 }),
    ]);
    const code = runTriagePromote(
      { from: "/tmp/p.json", dryRun: true, limit: 0, only: 2 },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!).issue).toBe(2);
  });

  test("--limit truncates after --only filtering", () => {
    const { audit, o, deps } = setup([
      promoteRow({ number: 1 }),
      promoteRow({ number: 2 }),
      promoteRow({ number: 3 }),
    ]);
    runTriagePromote({ from: "/tmp/p.json", dryRun: true, limit: 2 }, o.output, deps);
    expect(audit).toHaveLength(2);
  });

  test("defensive idempotency: skip if beads has the row at apply time even when plan says promote", () => {
    const { audit, o, deps, bdCalls } = setup([promoteRow({ number: 42 })], {
      beadsAtApply: [
        bead({
          id: "bd-prior",
          externalRef: "https://github.com/bdelanghe/ai-home/issues/42",
          externalIssueNumber: 42,
        }),
      ],
    });
    const code = runTriagePromote({ from: "/tmp/p.json", dryRun: false, limit: 0 }, o.output, deps);
    expect(code).toBe(0);
    expect(bdCalls()).toBe(0);
    const entry = JSON.parse(audit[0]!);
    expect(entry.action).toBe("skip");
    expect(entry.decision).toBe("skip:already-in-bd");
    expect(entry.beadId).toBe("bd-prior");
  });

  test("partial-error: bd succeeds, gh comment fails — exit 1, audit logs partial", () => {
    const { audit, o, deps } = setup([promoteRow()], {
      bdResults: [{ exitCode: 0, stdout: "bd-7", stderr: "", policy: null }],
      ghResults: [{ exitCode: 1, stdout: "", stderr: "comment denied", policy: null }],
    });
    const code = runTriagePromote({ from: "/tmp/p.json", dryRun: false, limit: 0 }, o.output, deps);
    expect(code).toBe(1);
    const entry = JSON.parse(audit[0]!);
    expect(entry.action).toBe("partial-error");
    expect(entry.beadId).toBe("bd-7");
    expect(entry.stderr).toBe("comment denied");
  });

  test("error: bd create fails — exit 1, no gh call", () => {
    const { audit, o, deps, ghCalls } = setup([promoteRow()], {
      bdResults: [{ exitCode: 1, stdout: "", stderr: "bd boom", policy: null }],
    });
    const code = runTriagePromote({ from: "/tmp/p.json", dryRun: false, limit: 0 }, o.output, deps);
    expect(code).toBe(1);
    expect(ghCalls()).toBe(0);
    const entry = JSON.parse(audit[0]!);
    expect(entry.action).toBe("error");
    expect(entry.stderr).toBe("bd boom");
  });

  test("error: bd succeeds but stdout is empty — exit 1, no gh call", () => {
    const { audit, o, deps, ghCalls } = setup([promoteRow()], {
      bdResults: [{ exitCode: 0, stdout: "   \n", stderr: "", policy: null }],
    });
    const code = runTriagePromote({ from: "/tmp/p.json", dryRun: false, limit: 0 }, o.output, deps);
    expect(code).toBe(1);
    expect(ghCalls()).toBe(0);
    const entry = JSON.parse(audit[0]!);
    expect(entry.action).toBe("error");
    expect(entry.stderr).toMatch(/no parseable id/);
  });

  test("rejects plan that fails schema validation", () => {
    const o = makeOutput();
    const code = runTriagePromote({ from: "/tmp/p.json", dryRun: false, limit: 0 }, o.output, {
      ...STD_DEPS_BASE,
      readFileSync: () => JSON.stringify({ rows: [{ bogus: true }] }),
      loadAllBeads: () => [],
      auditSink: {
        ...STD_DEPS_BASE.auditSink,
        appendFn: () => {},
      },
      execBd: () => ({ exitCode: 0, stdout: "", stderr: "", policy: null }),
      execGh: () => ({ exitCode: 0, stdout: "", stderr: "", policy: null }),
    });
    expect(code).toBe(1);
    expect(o.error.join("\n")).toMatch(/schema validation/);
  });
});
