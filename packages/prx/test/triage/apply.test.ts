import { describe, expect, test } from "bun:test";

import {
  diffRow,
  runTriageApply,
} from "../../src/triage/apply.ts";
import type { GhExecResult } from "@bounded-systems/gh";
import type { LabelPlan, LabelPlanRow } from "../../src/triage/label-vocab.ts";

function row(overrides: Partial<LabelPlanRow> = {}): LabelPlanRow {
  return {
    number: 1,
    title: "feat: x",
    url: "https://github.com/bdelanghe/ai-home/issues/1",
    currentLabels: [],
    type: "feature",
    priority: "medium",
    ...overrides,
  };
}

function plan(rows: LabelPlanRow[]): LabelPlan {
  return {
    repo: "bdelanghe/ai-home",
    generatedAt: "2026-04-28T20:00:00Z",
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

describe("diffRow", () => {
  test("skip when current labels already match proposed", () => {
    const decision = diffRow(
      row({ currentLabels: ["type::feature", "priority::medium"] }),
    );
    expect(decision.kind).toBe("skip");
  });

  test("write adds labels when none present", () => {
    const decision = diffRow(row());
    expect(decision.kind).toBe("write");
    if (decision.kind !== "write") return;
    expect(decision.addLabels).toEqual(["type::feature", "priority::medium"]);
    expect(decision.removeLabels).toEqual([]);
  });

  test("GH-957: classifier disagrees with operator type+priority — both axes preserved", () => {
    const decision = diffRow(
      row({
        currentLabels: ["type::bug", "priority::low", "needs-triage"],
        type: "feature",
        priority: "medium",
      }),
    );
    expect(decision.kind).toBe("skip");
  });

  test("preserves operator-curated area::* / effort::* when classifier is silent at that axis", () => {
    const decision = diffRow(
      row({
        currentLabels: ["needs-triage", "area::tui", "effort::xl"],
        type: "feature",
        priority: "medium",
        // area / effort undefined — heuristic didn't fire
      }),
    );
    expect(decision.kind).toBe("write");
    if (decision.kind !== "write") return;
    expect(decision.removeLabels).toEqual([]);
  });

  test("GH-957: preserves operator-set area::* even when classifier emits at that axis", () => {
    const decision = diffRow(
      row({
        currentLabels: ["area::tui"],
        type: "feature",
        priority: "medium",
        area: "prx",
      }),
    );
    expect(decision.kind).toBe("write");
    if (decision.kind !== "write") return;
    expect(decision.addLabels).toEqual(["type::feature", "priority::medium"]);
    expect(decision.removeLabels).toEqual([]);
  });

  test("GH-957: preserves operator-set effort::* even when classifier emits at that axis", () => {
    const decision = diffRow(
      row({
        currentLabels: ["effort::xl"],
        type: "feature",
        priority: "medium",
        effort: "m",
      }),
    );
    expect(decision.kind).toBe("write");
    if (decision.kind !== "write") return;
    expect(decision.addLabels).toEqual(["type::feature", "priority::medium"]);
    expect(decision.removeLabels).toEqual([]);
  });

  test("foreign labels (needs-triage, typos) are never removed", () => {
    const decision = diffRow(
      row({
        currentLabels: ["needs-triage", "agent::architect"],
        type: "feature",
        priority: "medium",
      }),
    );
    expect(decision.kind).toBe("write");
    if (decision.kind !== "write") return;
    expect(decision.removeLabels).toEqual([]);
  });

  test("GH-952: classifier silent on type preserves operator-set type::epic", () => {
    const decision = diffRow(
      row({
        currentLabels: ["type::epic", "needs-triage"],
        type: undefined,
        priority: undefined,
      }),
    );
    expect(decision.kind).toBe("skip");
  });

  test("GH-952: classifier silent on priority preserves operator-set priority::high", () => {
    const decision = diffRow(
      row({
        currentLabels: ["type::feature", "priority::high"],
        type: "feature",
        priority: undefined,
      }),
    );
    // type::feature already there + classifier silent on priority → no diff.
    expect(decision.kind).toBe("skip");
  });

  test("GH-952: classifier emits type only — adds type, leaves operator priority alone", () => {
    const decision = diffRow(
      row({
        currentLabels: ["priority::high"],
        type: "bug",
        priority: undefined,
      }),
    );
    expect(decision.kind).toBe("write");
    if (decision.kind !== "write") return;
    expect(decision.addLabels).toEqual(["type::bug"]);
    expect(decision.removeLabels).toEqual([]);
  });

  test("GH-952: row with all axes undefined is a no-op skip even with stale axis labels", () => {
    const decision = diffRow(
      row({
        currentLabels: ["type::task", "priority::medium", "area::prx", "effort::m"],
        type: undefined,
        priority: undefined,
      }),
    );
    expect(decision.kind).toBe("skip");
  });

  test("GH-988: type::task is the unscored sentinel — scored classifier emission strips-and-replaces it", () => {
    // Under GH-988, type::task is the symmetric mirror of priority::none —
    // the unscored fallback sentinel, not an operator-set decision. So a
    // future scored classifier emission of type::bug (or any other
    // BD_TYPE_ENUM value other than `task`) strips and replaces it. Compare
    // GH-957: the same test against type::epic still skips (test below).
    const decision = diffRow(
      row({
        currentLabels: ["type::task", "priority::high"],
        type: "bug",
        priority: undefined,
      }),
    );
    expect(decision.kind).toBe("write");
    if (decision.kind !== "write") return;
    expect(decision.addLabels).toEqual(["type::bug"]);
    expect(decision.removeLabels).toEqual(["type::task"]);
  });

  test("GH-957: classifier emits type::feature, current [type::epic] — skip", () => {
    const decision = diffRow(
      row({
        currentLabels: ["type::epic"],
        type: "feature",
        priority: undefined,
      }),
    );
    expect(decision.kind).toBe("skip");
  });

  test("GH-957: classifier emits priority::medium, current [priority::high] — skip", () => {
    const decision = diffRow(
      row({
        currentLabels: ["priority::high"],
        type: undefined,
        priority: "medium",
      }),
    );
    expect(decision.kind).toBe("skip");
  });

  test("GH-957: classifier emits area::prx, current [area::beads] — skip", () => {
    const decision = diffRow(
      row({
        currentLabels: ["area::beads"],
        type: undefined,
        priority: undefined,
        area: "prx",
      }),
    );
    expect(decision.kind).toBe("skip");
  });

  test("GH-957: classifier emits effort::s, current [effort::xl] — skip", () => {
    const decision = diffRow(
      row({
        currentLabels: ["effort::xl"],
        type: undefined,
        priority: undefined,
        effort: "s",
      }),
    );
    expect(decision.kind).toBe("skip");
  });

  test("GH-957: mixed — operator type::epic + classifier emits type::feature + area::prx → adds area only", () => {
    const decision = diffRow(
      row({
        currentLabels: ["type::epic"],
        type: "feature",
        priority: undefined,
        area: "prx",
      }),
    );
    expect(decision.kind).toBe("write");
    if (decision.kind !== "write") return;
    expect(decision.addLabels).toEqual(["area::prx"]);
    expect(decision.removeLabels).toEqual([]);
  });

  test("GH-957: classifier silent everywhere + current [type::epic, area::beads] — skip (GH-952 invariant)", () => {
    const decision = diffRow(
      row({
        currentLabels: ["type::epic", "area::beads"],
        type: undefined,
        priority: undefined,
      }),
    );
    expect(decision.kind).toBe("skip");
  });

  test("GH-957: out-of-vocab axis label (type::saga) not treated as operator-set — classifier replaces it", () => {
    const decision = diffRow(
      row({
        currentLabels: ["type::saga"],
        type: "feature",
        priority: undefined,
      }),
    );
    expect(decision.kind).toBe("write");
    if (decision.kind !== "write") return;
    expect(decision.addLabels).toEqual(["type::feature"]);
    expect(decision.removeLabels).toEqual(["type::saga"]);
  });

  test("GH-1487: priority::none is the unscored sentinel — classifier upgrades replace it", () => {
    const decision = diffRow(
      row({
        currentLabels: ["priority::none"],
        type: undefined,
        priority: "high",
      }),
    );
    // priority::none is the GH-970 sentinel for "operator has not decided yet",
    // not an operator decision. The hasPriority gate excludes it (GH-1487), so
    // the classifier's priority emission strips-and-replaces it.
    expect(decision.kind).toBe("write");
    if (decision.kind !== "write") return;
    expect(decision.addLabels).toEqual(["priority::high"]);
    expect(decision.removeLabels).toEqual(["priority::none"]);
  });

  test("GH-1487: priority::none → priority::high is a strip-and-replace, not a skip", () => {
    const decision = diffRow(
      row({
        currentLabels: ["priority::none", "type::bug"],
        type: undefined,
        priority: "high",
      }),
    );
    expect(decision.kind).toBe("write");
    if (decision.kind !== "write") return;
    expect(decision.addLabels).toEqual(["priority::high"]);
    expect(decision.removeLabels).toEqual(["priority::none"]);
  });

  test("GH-1487: operator-set priority::high still wins when classifier emits priority::none", () => {
    // Inverse case — the GH-957 preservation guarantee for real operator
    // priorities must survive the GH-1487 carve-out. Only `priority::none`
    // loses sentinel status.
    const decision = diffRow(
      row({
        currentLabels: ["priority::high"],
        type: undefined,
        priority: "none",
        priorityConfidence: "unscored",
      }),
    );
    expect(decision.kind).toBe("skip");
  });

  test("GH-970: classifier emits priority::none on a clean issue → adds the unscored marker", () => {
    const decision = diffRow(
      row({
        currentLabels: [],
        type: undefined,
        priority: "none",
        priorityConfidence: "unscored",
      }),
    );
    expect(decision.kind).toBe("write");
    if (decision.kind !== "write") return;
    expect(decision.addLabels).toEqual(["priority::none"]);
    expect(decision.removeLabels).toEqual([]);
  });

  test("GH-970: defaulted priority::none does NOT strip operator-set priority::high", () => {
    const decision = diffRow(
      row({
        currentLabels: ["priority::high"],
        type: undefined,
        priority: "none",
        priorityConfidence: "unscored",
      }),
    );
    // Operator-set priority is authoritative; the defaulted unscored marker
    // is suppressed by the hasPriority gate.
    expect(decision.kind).toBe("skip");
  });

  test("GH-970: re-applying priority::none on already-marked issue is idempotent", () => {
    const decision = diffRow(
      row({
        currentLabels: ["priority::none"],
        type: undefined,
        priority: "none",
        priorityConfidence: "unscored",
      }),
    );
    expect(decision.kind).toBe("skip");
  });

  // ── GH-988: type::task sentinel + spike dual-emission ────────────────────

  test("GH-988: clean issue + unscored fallback type::task is adds-only", () => {
    const decision = diffRow(
      row({
        currentLabels: [],
        type: "task",
        typeConfidence: "unscored",
        priority: undefined,
      }),
    );
    expect(decision.kind).toBe("write");
    if (decision.kind !== "write") return;
    expect(decision.addLabels).toEqual(["type::task"]);
    expect(decision.removeLabels).toEqual([]);
  });

  test("GH-988: re-applying type::task on already-marked issue is idempotent", () => {
    const decision = diffRow(
      row({
        currentLabels: ["type::task"],
        type: "task",
        typeConfidence: "unscored",
        priority: undefined,
      }),
    );
    expect(decision.kind).toBe("skip");
  });

  test("GH-988: type::task is the unscored sentinel — operator-set type::feature still wins over fallback", () => {
    // Inverse case for the type carve-out — real operator types must
    // continue to suppress the fallback, mirroring the priority::high path.
    const decision = diffRow(
      row({
        currentLabels: ["type::feature"],
        type: "task",
        typeConfidence: "unscored",
        priority: undefined,
      }),
    );
    expect(decision.kind).toBe("skip");
  });

  test("GH-988 + GH-1489: spike dual-emission adds type::task and type::spike on a clean issue", () => {
    const decision = diffRow(
      row({
        currentLabels: [],
        type: "task",
        typeConfidence: "scored",
        spike: true,
        priority: undefined,
      }),
    );
    expect(decision.kind).toBe("write");
    if (decision.kind !== "write") return;
    expect(decision.addLabels).toEqual(["type::task", "type::spike"]);
    expect(decision.removeLabels).toEqual([]);
  });

  test("GH-988 + GH-1489: legacy spike-only (type::spike) gains type::task without stripping the marker", () => {
    const decision = diffRow(
      row({
        currentLabels: ["type::spike"],
        type: "task",
        typeConfidence: "unscored",
        spike: true,
        priority: undefined,
      }),
    );
    expect(decision.kind).toBe("write");
    if (decision.kind !== "write") return;
    expect(decision.addLabels).toEqual(["type::task"]);
    expect(decision.removeLabels).toEqual([]);
  });

  test("GH-988: type::spike is never the type-axis decision — operator type::feature still strips fallback type::task", () => {
    const decision = diffRow(
      row({
        currentLabels: ["type::task", "type::spike"],
        type: "feature",
        typeConfidence: "scored",
        priority: undefined,
      }),
    );
    // type::task is the sentinel, type::spike is GH-only marker; neither
    // counts toward hasType. Classifier scored emission of type::feature
    // strips type::task (sentinel) and preserves type::spike (marker).
    expect(decision.kind).toBe("write");
    if (decision.kind !== "write") return;
    expect(decision.addLabels).toEqual(["type::feature"]);
    expect(decision.removeLabels).toEqual(["type::task"]);
  });
});

describe("runTriageApply", () => {
  // GH-1866 — default fetchLiveLabels seam echoes plan.currentLabels per row
  // so existing tests (which were written before GH-1866 introduced the
  // batched live-GH fetch) continue to exercise the same axis-gate logic.
  // New tests in the GH-1866 suite below override this to inject a divergent
  // live snapshot.
  function defaultLiveLabels(rows: LabelPlanRow[]) {
    return (_repo: string, numbers: number[]): Map<number, string[]> => {
      const map = new Map<number, string[]>();
      for (const n of numbers) {
        const r = rows.find((row) => row.number === n);
        map.set(n, r ? [...r.currentLabels] : []);
      }
      return map;
    };
  }

  function setup(planRows: LabelPlanRow[], execResults: GhExecResult[] = []) {
    const audit: string[] = [];
    let execIndex = 0;
    const execGh = () => {
      const result =
        execResults[execIndex] ??
        ({ exitCode: 0, stdout: "", stderr: "", policy: null } as GhExecResult);
      execIndex += 1;
      return result;
    };
    const fixture = JSON.stringify(plan(planRows));
    const o = makeOutput();
    const deps = {
      execGh,
      readFileSync: () => fixture,
      now: () => new Date("2026-04-28T20:00:00Z"),
      auditSink: {
        stateDirOverride: "/tmp/state",
        ensureDir: () => {},
        appendFn: (_path: string, line: string) => audit.push(line),
      },
      fetchLiveLabels: defaultLiveLabels(planRows),
    };
    return { audit, o, deps, execIndex: () => execIndex };
  }

  test("dry-run writes audit entries with dryRun:true and no exec calls", async () => {
    const { audit, o, deps, execIndex } = setup([row()]);
    const code = await runTriageApply(
      { plan: "/tmp/plan.json", dryRun: true, limit: 0, sync: false },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    expect(execIndex()).toBe(0);
    expect(audit).toHaveLength(1);
    const entry = JSON.parse(audit[0]!);
    expect(entry.dryRun).toBe(true);
    expect(entry.action).toBe("add-remove");
    expect(entry.add).toEqual(["type::feature", "priority::medium"]);
  });

  test("apply with no diff is a no-op skip (idempotent)", async () => {
    const { audit, o, deps, execIndex } = setup([
      row({ currentLabels: ["type::feature", "priority::medium"] }),
    ]);
    const code = await runTriageApply(
      { plan: "/tmp/plan.json", dryRun: false, limit: 0, sync: false },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    expect(execIndex()).toBe(0);
    expect(JSON.parse(audit[0]!).action).toBe("skip");
  });

  test("apply issues gh issue edit for diff rows", async () => {
    const calls: Array<{ group: string; sub: string; args: string[] }> = [];
    const fixture = JSON.stringify(plan([row({ number: 42 })]));
    const o = makeOutput();
    const code = await runTriageApply(
      { plan: "/tmp/plan.json", dryRun: false, limit: 0, sync: false },
      o.output,
      {
        execGh: (opts) => {
          calls.push({ group: opts.group, sub: opts.subcommand, args: opts.args });
          return { exitCode: 0, stdout: "", stderr: "", policy: null };
        },
        readFileSync: () => fixture,
        now: () => new Date("2026-04-28T20:00:00Z"),
        auditSink: {
          stateDirOverride: "/tmp/state",
          ensureDir: () => {},
          appendFn: () => {},
        },
        fetchLiveLabels: () => new Map([[42, []]]),
      },
    );
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.group).toBe("issue");
    expect(calls[0]!.sub).toBe("edit");
    expect(calls[0]!.args[0]!).toBe("42");
    expect(calls[0]!.args).toContain("--add-label");
    expect(calls[0]!.args).toContain("type::feature,priority::medium");
    expect(calls[0]!.args).toContain("--repo");
    expect(calls[0]!.args).toContain("bdelanghe/ai-home");
  });

  test("--limit truncates rows", async () => {
    const { audit, o, deps } = setup([
      row({ number: 1 }),
      row({ number: 2 }),
      row({ number: 3 }),
    ]);
    const code = await runTriageApply(
      { plan: "/tmp/plan.json", dryRun: true, limit: 2, sync: false },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    expect(audit).toHaveLength(2);
  });

  test("propagates non-zero exec exit codes as errors and returns 1", async () => {
    const { audit, o, deps } = setup(
      [row({ number: 7 })],
      [{ exitCode: 1, stdout: "", stderr: "boom", policy: null }],
    );
    const code = await runTriageApply(
      { plan: "/tmp/plan.json", dryRun: false, limit: 0, sync: false },
      o.output,
      deps,
    );
    expect(code).toBe(1);
    const entry = JSON.parse(audit[0]!);
    expect(entry.action).toBe("error");
    expect(entry.exitCode).toBe(1);
    expect(entry.stderr).toBe("boom");
  });

  test("rejects plan that fails schema validation", async () => {
    const o = makeOutput();
    const code = await runTriageApply(
      { plan: "/tmp/plan.json", dryRun: false, limit: 0, sync: false },
      o.output,
      {
        readFileSync: () => JSON.stringify({ rows: [{ bogus: true }] }),
        now: () => new Date(),
        auditSink: {
          stateDirOverride: "/tmp/state",
          ensureDir: () => {},
          appendFn: () => {},
        },
        execGh: () => ({ exitCode: 0, stdout: "", stderr: "", policy: null }),
        fetchLiveLabels: () => new Map(),
      },
    );
    expect(code).toBe(1);
    expect(o.error.join("\n")).toContain("schema validation");
  });
});

describe("runTriageApply — bd github sync chaining (GH-971)", () => {
  // GH-2011: the post-write reconcile now routes through `runBeadsSync` (the
  // canonical reconcile) instead of the retired `bd github sync` shell-out.
  // The seam below mirrors the new shape — a function that returns a
  // Promise<BeadsSyncResult>.
  function setupSync(
    planRows: LabelPlanRow[],
    syncResult: { exitCode: number; stdout: string; stderr: string },
  ) {
    const audit: string[] = [];
    let execIndex = 0;
    const execGh = () => {
      execIndex += 1;
      return { exitCode: 0, stdout: "", stderr: "", policy: null } as GhExecResult;
    };
    const fixture = JSON.stringify(plan(planRows));
    const o = makeOutput();
    let syncCalls = 0;
    const pulledFromStdout = syncResult.stdout.match(/synced (\d+)/);
    const pulledCount = pulledFromStdout ? Number(pulledFromStdout[1]) : 0;
    const deps = {
      execGh,
      readFileSync: () => fixture,
      now: () => new Date("2026-04-28T20:00:00Z"),
      auditSink: {
        stateDirOverride: "/tmp/state",
        ensureDir: () => {},
        appendFn: (_path: string, line: string) => audit.push(line),
      },
      runBeadsSync: (async (
        _opts: unknown,
        output: { log: (l: string) => void; error: (l: string) => void },
      ) => {
        syncCalls += 1;
        if (syncResult.stdout.trim()) output.log(syncResult.stdout.trim());
        if (syncResult.stderr.trim()) output.error(syncResult.stderr.trim());
        return {
          exitCode: syncResult.exitCode,
          summary: {
            repo: "bdelanghe/ai-home",
            domain: "gh",
            scanned: 0,
            pinned: 0,
            skipped: 0,
            pulled: pulledCount,
            pushed: 0,
            closedByPull: 0,
            failed: 0,
            deferred: 0,
            budgetPaused: false,
            dryRun: false,
            durationMs: 0,
          },
          pairs: [],
        };
      }) as any,
      fetchLiveLabels: (_repo: string, numbers: number[]) => {
        const map = new Map<number, string[]>();
        for (const n of numbers) {
          const r = planRows.find((row) => row.number === n);
          map.set(n, r ? [...r.currentLabels] : []);
        }
        return map;
      },
    };
    return { audit, o, deps, syncCalls: () => syncCalls };
  }

  test("default invocation with writes triggers exactly one sync call and tail audit entry", async () => {
    const { audit, o, deps, syncCalls } = setupSync(
      [row({ number: 11 }), row({ number: 22 })],
      { exitCode: 0, stdout: "synced 2 issues\n", stderr: "" },
    );
    const code = await runTriageApply(
      { plan: "/tmp/plan.json", dryRun: false, limit: 0, sync: true },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    expect(syncCalls()).toBe(1);
    expect(audit).toHaveLength(3); // 2 row entries + 1 sync entry
    const tail = JSON.parse(audit[audit.length - 1]!);
    expect(tail.action).toBe("sync");
    expect(tail.touchedIssues).toEqual([11, 22]);
    expect(tail.bdExitCode).toBe(0);
    expect(tail.bdStdout).toContain("synced 2 issues");
    expect(o.log.join("\n")).toContain("OK bd github sync: 2 issue(s) reconciled");
    expect(o.log.join("\n")).toContain("sync=ok");
  });

  test("--no-sync (sync:false) suppresses bd invocation even with writes", async () => {
    const { audit, o, deps, syncCalls } = setupSync([row({ number: 5 })], {
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    const code = await runTriageApply(
      { plan: "/tmp/plan.json", dryRun: false, limit: 0, sync: false },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    expect(syncCalls()).toBe(0);
    expect(audit).toHaveLength(1);
    expect(o.log.join("\n")).toContain("sync=skipped");
  });

  test("dry-run suppresses sync regardless of sync flag", async () => {
    const { audit, o, deps, syncCalls } = setupSync([row({ number: 5 })], {
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    const code = await runTriageApply(
      { plan: "/tmp/plan.json", dryRun: true, limit: 0, sync: true },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    expect(syncCalls()).toBe(0);
    expect(audit).toHaveLength(1);
    expect(o.log.join("\n")).toContain("sync=skipped");
  });

  test("all-skip plan (zero writes) suppresses sync", async () => {
    const { audit, o, deps, syncCalls } = setupSync(
      [row({ currentLabels: ["type::feature", "priority::medium"] })],
      { exitCode: 0, stdout: "", stderr: "" },
    );
    const code = await runTriageApply(
      { plan: "/tmp/plan.json", dryRun: false, limit: 0, sync: true },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    expect(syncCalls()).toBe(0);
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!).action).toBe("skip");
    expect(o.log.join("\n")).toContain("sync=skipped");
  });

  test("sync failure flips apply exit to 1 and records non-zero bdExitCode", async () => {
    const { audit, o, deps, syncCalls } = setupSync([row({ number: 7 })], {
      exitCode: 2,
      stdout: "",
      stderr: "bd: token expired",
    });
    const code = await runTriageApply(
      { plan: "/tmp/plan.json", dryRun: false, limit: 0, sync: true },
      o.output,
      deps,
    );
    expect(code).toBe(1);
    expect(syncCalls()).toBe(1);
    expect(audit).toHaveLength(2);
    const tail = JSON.parse(audit[1]!);
    expect(tail.action).toBe("sync");
    expect(tail.bdExitCode).toBe(2);
    expect(tail.bdStderr).toBe("bd: token expired");
    expect(tail.touchedIssues).toEqual([7]);
    expect(o.error.join("\n")).toContain("FAIL bd github sync: bd: token expired");
    expect(o.log.join("\n")).toContain("sync=failed");
  });

  test("touched issues exclude rows that errored at gh-edit time", async () => {
    const audit: string[] = [];
    const fixture = JSON.stringify(plan([row({ number: 1 }), row({ number: 2 })]));
    const o = makeOutput();
    let syncCalls = 0;
    const execResults: GhExecResult[] = [
      { exitCode: 0, stdout: "", stderr: "", policy: null },
      { exitCode: 1, stdout: "", stderr: "rate limit", policy: null },
    ];
    let execIndex = 0;
    const code = await runTriageApply(
      { plan: "/tmp/plan.json", dryRun: false, limit: 0, sync: true },
      o.output,
      {
        execGh: () => execResults[execIndex++]!,
        readFileSync: () => fixture,
        now: () => new Date("2026-04-28T20:00:00Z"),
        auditSink: {
          stateDirOverride: "/tmp/state",
          ensureDir: () => {},
          appendFn: (_p: string, line: string) => audit.push(line),
        },
        runBeadsSync: (async (
          _opts: unknown,
          _output: { log: (l: string) => void; error: (l: string) => void },
        ) => {
          syncCalls += 1;
          return {
            exitCode: 0,
            summary: {
              repo: "bdelanghe/ai-home",
              domain: "gh",
              scanned: 0,
              pinned: 0,
              skipped: 0,
              pulled: 1,
              pushed: 0,
              closedByPull: 0,
              failed: 0,
              deferred: 0,
              budgetPaused: false,
              dryRun: false,
              durationMs: 0,
            },
            pairs: [],
          };
        }) as any,
        fetchLiveLabels: () => new Map([[1, []], [2, []]]),
      },
    );
    expect(code).toBe(1); // gh-edit error still flips exit to 1
    expect(syncCalls).toBe(1); // but sync still runs because writes>0
    const tail = JSON.parse(audit[audit.length - 1]!);
    expect(tail.action).toBe("sync");
    expect(tail.touchedIssues).toEqual([1]); // issue 2 errored, not touched
  });
});

// GH-1866 — `diffRow(row, liveLabels)` gates type/priority/area/effort
// emission against the live GH snapshot, not the plan's bd-cache
// `currentLabels`. Reproduces the 2026-05-16 stacking incident where
// `prx triage apply` saw bd's stale `["area::prx"]` and emitted `type::task`
// on top of an operator-set `type::feature` on GH.
describe("diffRow — GH-1866 liveLabels override", () => {
  test("regression: stale bd row does not stack type::task on operator-set type::feature", () => {
    const decision = diffRow(
      row({
        currentLabels: ["area::prx"], // bd cache claims only the area axis
        type: "task",
        typeConfidence: "unscored",
        priority: undefined,
      }),
      // live GH carries the operator-set type::feature + priority::critical
      ["type::feature", "priority::critical", "area::prx", "priority::none"],
    );
    expect(decision.kind).toBe("skip");
  });

  test("regression: stale bd row preserves operator-scored priority::high", () => {
    const decision = diffRow(
      row({
        currentLabels: [],
        type: undefined,
        priority: "none",
        priorityConfidence: "unscored",
      }),
      ["priority::high"],
    );
    expect(decision.kind).toBe("skip");
  });

  test("strip-union: no-op when operator priority::high preserves the axis", () => {
    // bd cache has stale priority::none (already removed from GH), live carries
    // operator-set priority::high. Live's hasPriority gate ⇒ true, so the
    // classifier's priority::none unscored sentinel is suppressed. The bd-side
    // priority::none is preserved by the GH-957 per-axis strip gate (an
    // operator-set label at the axis is authoritative). The next bd github
    // sync will reconcile the bd cache.
    const decision = diffRow(
      row({
        currentLabels: ["priority::none"],
        type: undefined,
        priority: "none",
        priorityConfidence: "unscored",
      }),
      ["priority::high"],
    );
    expect(decision.kind).toBe("skip");
  });

  test("strip-union: bd-side stale type::saga is stripped even when live no longer carries it", () => {
    // bd cache lags behind GH — operator removed type::saga from GH but bd
    // still shows it. Classifier emits type::bug on a row with no live type.
    // The strip-union (currentLabels ∪ liveLabels) carries the bd-side
    // type::saga through the per-axis strip gate so the bd-side stale label
    // is cleaned via the gh edit (and the sync chain restores bd alignment).
    const decision = diffRow(
      row({
        currentLabels: ["type::saga"],
        type: "bug",
        priority: undefined,
      }),
      [],
    );
    expect(decision.kind).toBe("write");
    if (decision.kind !== "write") return;
    expect(decision.addLabels).toEqual(["type::bug"]);
    expect(decision.removeLabels).toEqual(["type::saga"]);
  });

  test("liveLabels=currentLabels preserves existing diffRow behavior", () => {
    // Parameterized echo of the GH-957 "type::epic + classifier emits
    // type::feature, area::prx → adds area only" case. Confirms no regression
    // when the live snapshot matches the plan's bd-cache.
    const decision = diffRow(
      row({
        currentLabels: ["type::epic"],
        type: "feature",
        priority: undefined,
        area: "prx",
      }),
      ["type::epic"],
    );
    expect(decision.kind).toBe("write");
    if (decision.kind !== "write") return;
    expect(decision.addLabels).toEqual(["area::prx"]);
    expect(decision.removeLabels).toEqual([]);
  });

  test("liveLabels divergent from currentLabels: live is authoritative for gates", () => {
    // bd cache says we have no type, but live GH has type::feature. Classifier
    // emits type::bug. Live's hasType ⇒ true, so no axis change.
    const decision = diffRow(
      row({
        currentLabels: [],
        type: "bug",
        priority: undefined,
      }),
      ["type::feature"],
    );
    expect(decision.kind).toBe("skip");
  });
});

describe("runTriageApply — GH-1866 batched live-label fetch", () => {
  test("issues exactly one fetchLiveLabels call per pass, regardless of row count", async () => {
    const fixture = JSON.stringify(
      plan([row({ number: 1 }), row({ number: 2 }), row({ number: 3 })]),
    );
    const o = makeOutput();
    let fetchCalls = 0;
    const code = await runTriageApply(
      { plan: "/tmp/plan.json", dryRun: false, limit: 0, sync: false },
      o.output,
      {
        execGh: () => ({ exitCode: 0, stdout: "", stderr: "", policy: null }),
        readFileSync: () => fixture,
        now: () => new Date("2026-04-28T20:00:00Z"),
        auditSink: {
          stateDirOverride: "/tmp/state",
          ensureDir: () => {},
          appendFn: () => {},
        },
        fetchLiveLabels: (_repo: string, numbers: number[]) => {
          fetchCalls += 1;
          expect(numbers).toEqual([1, 2, 3]);
          return new Map(numbers.map((n) => [n, [] as string[]]));
        },
      },
    );
    expect(code).toBe(0);
    expect(fetchCalls).toBe(1);
  });

  test("dry-run still fetches live labels (preview honesty)", async () => {
    const fixture = JSON.stringify(plan([row({ number: 7 })]));
    const o = makeOutput();
    let fetchCalls = 0;
    const code = await runTriageApply(
      { plan: "/tmp/plan.json", dryRun: true, limit: 0, sync: false },
      o.output,
      {
        execGh: () => ({ exitCode: 0, stdout: "", stderr: "", policy: null }),
        readFileSync: () => fixture,
        now: () => new Date("2026-04-28T20:00:00Z"),
        auditSink: {
          stateDirOverride: "/tmp/state",
          ensureDir: () => {},
          appendFn: () => {},
        },
        fetchLiveLabels: () => {
          fetchCalls += 1;
          return new Map([[7, []]]);
        },
      },
    );
    expect(code).toBe(0);
    expect(fetchCalls).toBe(1);
  });

  test("fail-closed: fetch throw aborts without any gh issue edit calls", async () => {
    const fixture = JSON.stringify(plan([row({ number: 9 })]));
    const o = makeOutput();
    let execCalls = 0;
    const code = await runTriageApply(
      { plan: "/tmp/plan.json", dryRun: false, limit: 0, sync: false },
      o.output,
      {
        execGh: () => {
          execCalls += 1;
          return { exitCode: 0, stdout: "", stderr: "", policy: null };
        },
        readFileSync: () => fixture,
        now: () => new Date("2026-04-28T20:00:00Z"),
        auditSink: {
          stateDirOverride: "/tmp/state",
          ensureDir: () => {},
          appendFn: () => {},
        },
        fetchLiveLabels: () => {
          throw new Error("rate limit exceeded");
        },
      },
    );
    expect(code).toBe(2);
    expect(execCalls).toBe(0);
    expect(o.error.join("\n")).toContain("live-label fetch failed");
    expect(o.error.join("\n")).toContain("rate limit exceeded");
  });

  test("fail-closed: missing alias for a row aborts the pass", async () => {
    const fixture = JSON.stringify(plan([row({ number: 9 }), row({ number: 10 })]));
    const o = makeOutput();
    let execCalls = 0;
    const code = await runTriageApply(
      { plan: "/tmp/plan.json", dryRun: false, limit: 0, sync: false },
      o.output,
      {
        execGh: () => {
          execCalls += 1;
          return { exitCode: 0, stdout: "", stderr: "", policy: null };
        },
        readFileSync: () => fixture,
        now: () => new Date("2026-04-28T20:00:00Z"),
        auditSink: {
          stateDirOverride: "/tmp/state",
          ensureDir: () => {},
          appendFn: () => {},
        },
        // Returns a map that's missing issue 10 — fail-closed must catch this.
        fetchLiveLabels: () => new Map([[9, []]]),
      },
    );
    expect(code).toBe(2);
    expect(execCalls).toBe(0);
    expect(o.error.join("\n")).toContain("missing issue 10");
  });

  test("audit prev field reflects live-GH snapshot (not plan currentLabels)", async () => {
    const fixture = JSON.stringify(
      plan([row({ number: 42, currentLabels: ["area::prx"] })]),
    );
    const audit: string[] = [];
    const o = makeOutput();
    const code = await runTriageApply(
      { plan: "/tmp/plan.json", dryRun: true, limit: 0, sync: false },
      o.output,
      {
        execGh: () => ({ exitCode: 0, stdout: "", stderr: "", policy: null }),
        readFileSync: () => fixture,
        now: () => new Date("2026-04-28T20:00:00Z"),
        auditSink: {
          stateDirOverride: "/tmp/state",
          ensureDir: () => {},
          appendFn: (_p: string, line: string) => audit.push(line),
        },
        fetchLiveLabels: () =>
          new Map([[42, ["type::feature", "area::prx", "priority::high"]]]),
      },
    );
    expect(code).toBe(0);
    const entry = JSON.parse(audit[0]!);
    expect(entry.prev).toEqual(["type::feature", "area::prx", "priority::high"]);
    // plan-side currentLabels (`["area::prx"]`) intentionally not present in prev.
  });

  test("end-to-end regression: 2026-05-16 GH-398 corruption shape no longer stacks", async () => {
    // Reproduces the audit-log shape from the 2026-05-16 incident:
    //   plan row: { number: 398, currentLabels: ["area::prx"],
    //               type: "task", typeConfidence: "unscored" }
    //   live GH:  ["type::feature", "priority::critical", "area::prx",
    //              "priority::none"]
    // Pre-fix: apply emitted `add type::task` on top of operator-set
    // type::feature. Post-fix: apply skips the row entirely.
    const fixture = JSON.stringify(
      plan([
        row({
          number: 398,
          currentLabels: ["area::prx"],
          type: "task",
          typeConfidence: "unscored",
          priority: undefined,
        }),
      ]),
    );
    const calls: Array<{ args: string[] }> = [];
    const audit: string[] = [];
    const o = makeOutput();
    const code = await runTriageApply(
      { plan: "/tmp/plan.json", dryRun: false, limit: 0, sync: false },
      o.output,
      {
        execGh: (opts) => {
          calls.push({ args: opts.args });
          return { exitCode: 0, stdout: "", stderr: "", policy: null };
        },
        readFileSync: () => fixture,
        now: () => new Date("2026-05-16T20:00:00Z"),
        auditSink: {
          stateDirOverride: "/tmp/state",
          ensureDir: () => {},
          appendFn: (_p: string, line: string) => audit.push(line),
        },
        fetchLiveLabels: () =>
          new Map([
            [
              398,
              ["type::feature", "priority::critical", "area::prx", "priority::none"],
            ],
          ]),
      },
    );
    expect(code).toBe(0);
    expect(calls).toEqual([]); // no gh issue edit ⇒ no stacking
    const entry = JSON.parse(audit[0]!);
    expect(entry.action).toBe("skip");
  });
});
