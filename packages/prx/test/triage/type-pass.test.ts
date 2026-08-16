// GH-1021 — `prx triage type-pass` (Haiku batch type classifier).
//
// Tests the verb at three layers:
//   1. selectCandidates — pure function over FallbackIssue[]
//   2. parseHaikuEnvelope — boundary parser for `claude --print` JSON output
//   3. runTriageTypePass — full CLI handler with mocked spawnHaiku, execGh,
//      runBeadsSync (GH-2011 canonical reconcile, replaces the retired
//      `bd github sync` shell-out), auditSink (sink-side DI from
//      src/audit/sink.ts), now
//
// Mirrors test/triage/prioritize.test.ts in shape; uses bun:test.

import { describe, expect, test } from "bun:test";

import {
  TYPE_PASS_SYSTEM_PROMPT,
  haikuBatchResponseSchema,
  parseHaikuEnvelope,
  runTriageTypePass,
  selectCandidates,
  type SpawnHaiku,
  type SpawnHaikuResult,
  type TriageTypePassDeps,
  type TypePassAuditEntry,
  type TypePassAuditRowEntry,
  type TypePassAuditSyncEntry,
} from "../../src/triage/type-pass.ts";
import { triageTypePassOptionsSchema } from "../../src/triage/schemas/index.ts";
import type { GhExecResult } from "@bounded-systems/gh";
import type { FallbackIssue } from "../../src/pr-state/github.ts";

function issue(overrides: Partial<FallbackIssue> = {}): FallbackIssue {
  const number = overrides.number ?? 1;
  return {
    number,
    title: overrides.title ?? `feat: thing-${number}`,
    url: overrides.url ?? `https://github.com/bdelanghe/ai-home/issues/${number}`,
    labels: overrides.labels ?? [],
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

function envelope(rows: unknown, cost = 0.05): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    result: JSON.stringify(rows),
    total_cost_usd: cost,
  });
}

// CLI ≥ 2.1 emits stream-JSON arrays; the terminal element carries `result`.
// GH-1095 added array-shape support; this helper exercises that path.
function arrayEnvelope(rows: unknown, cost = 0.05): string {
  return JSON.stringify([
    { type: "system", subtype: "init", session_id: "s1", cwd: "/t" },
    { type: "assistant", message: { content: "..." } },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: JSON.stringify(rows),
      total_cost_usd: cost,
    },
  ]);
}

const FROZEN = new Date("2026-04-29T10:00:00.000Z");

function makeZeroBeadsSyncResult(repo = "bdelanghe/ai-home") {
  return Promise.resolve({
    exitCode: 0,
    summary: {
      repo,
      domain: "gh",
      scanned: 0,
      pinned: 0,
      skipped: 0,
      pulled: 0,
      pushed: 0,
      closedByPull: 0,
      failed: 0,
      pullFailed: 0,
      pullDeferred: 0,
      pushDeferred: 0,
      deferred: 0,
      budgetPaused: false,
      dryRun: false,
      durationMs: 0,
    },
    pairs: [],
  });
}

const baseOpts = triageTypePassOptionsSchema.parse({
  repo: "bdelanghe/ai-home",
  model: "claude-haiku-4-5-20251001",
  batchSize: 30,
  limit: 0,
  dryRun: false,
});

// ── selectCandidates ───────────────────────────────────────────────────────

describe("selectCandidates", () => {
  test("includes rows with no type::* axis label", () => {
    const c = selectCandidates([issue({ number: 1, labels: [{ name: "priority::high" }] })]);
    expect(c).toHaveLength(1);
    expect(c[0]!.number).toBe(1);
  });

  test("excludes rows with any type::* axis label", () => {
    const c = selectCandidates([
      issue({ number: 2, labels: [{ name: "type::bug" }, { name: "priority::high" }] }),
      issue({ number: 3, labels: [{ name: "type::feature" }] }),
      issue({ number: 4, labels: [{ name: "type::epic" }] }),
    ]);
    expect(c).toEqual([]);
  });

  test("foreign labels do not count as type axis", () => {
    const c = selectCandidates([
      issue({ number: 5, labels: [{ name: "needs-triage" }, { name: "agent::architect" }] }),
    ]);
    expect(c).toHaveLength(1);
  });

  test("sorts by issue number ascending for stable batch ordering", () => {
    const c = selectCandidates([issue({ number: 7 }), issue({ number: 3 }), issue({ number: 5 })]);
    expect(c.map((x) => x.number)).toEqual([3, 5, 7]);
  });
});

// ── system prompt + schema (golden) ────────────────────────────────────────

describe("TYPE_PASS_SYSTEM_PROMPT", () => {
  test("constrains type vocabulary to the round-trippable five values", () => {
    // GH-1058: bd github sync only round-trips bug/feature/task/chore/epic.
    // The prompt may mention out-of-vocab tokens in routing rules (e.g.
    // "refactor( prefix → task") but the constrained output vocabulary line
    // must list only the five round-trippable values. GH-988 widens the
    // shape with a `spike` boolean side-channel — `type` itself stays
    // in BD_TYPE_ENUM.
    const outputLine =
      '{"number": <int>, "type": "bug"|"feature"|"task"|"epic"|"chore", "spike": true|false, "confidence": "high"|"medium"|"low"}';
    expect(TYPE_PASS_SYSTEM_PROMPT).toContain(outputLine);
  });

  test("GH-988: prompt instructs spike-bit emission alongside the bd-axis type", () => {
    expect(TYPE_PASS_SYSTEM_PROMPT).toContain("Spike bit");
    expect(TYPE_PASS_SYSTEM_PROMPT).toContain("spike: true");
  });

  test("forbids prose / fence wrapping in output", () => {
    expect(TYPE_PASS_SYSTEM_PROMPT).toContain("Emit ONLY the JSON array");
  });
});

describe("haikuBatchResponseSchema", () => {
  test("accepts the validated 5-axis vocab + confidence triplet", () => {
    const ok = haikuBatchResponseSchema.parse([
      { number: 1, type: "bug", confidence: "high" },
      { number: 2, type: "feature", confidence: "medium" },
      { number: 3, type: "task", confidence: "low" },
      { number: 4, type: "epic", confidence: "high" },
      { number: 5, type: "chore", confidence: "low" },
    ]);
    expect(ok).toHaveLength(5);
  });

  test("rejects out-of-vocab type values (round-trip violation)", () => {
    expect(() =>
      haikuBatchResponseSchema.parse([{ number: 1, type: "decision", confidence: "high" }]),
    ).toThrow();
    expect(() =>
      haikuBatchResponseSchema.parse([{ number: 1, type: "spike", confidence: "high" }]),
    ).toThrow();
  });

  test("rejects rows missing confidence", () => {
    expect(() => haikuBatchResponseSchema.parse([{ number: 1, type: "bug" }])).toThrow();
  });
});

// ── parseHaikuEnvelope ─────────────────────────────────────────────────────

describe("parseHaikuEnvelope", () => {
  test("extracts rows + cost from a clean envelope", () => {
    const stdout = envelope([{ number: 1, type: "bug", confidence: "high" }], 0.07);
    const { rows, cost } = parseHaikuEnvelope(stdout);
    expect(rows).toEqual([{ number: 1, type: "bug", confidence: "high" }]);
    expect(cost).toBe(0.07);
  });

  test("tolerates ```json fence wrapping defensively", () => {
    const fenced = `\`\`\`json\n${JSON.stringify([{ number: 1, type: "bug", confidence: "high" }])}\n\`\`\``;
    const stdout = JSON.stringify({
      type: "result",
      subtype: "success",
      result: fenced,
    });
    const { rows } = parseHaikuEnvelope(stdout);
    expect(rows).toHaveLength(1);
  });

  test("throws when the envelope has no `result` string", () => {
    expect(() => parseHaikuEnvelope(JSON.stringify({ type: "result" }))).toThrow(
      /missing string "result" field/,
    );
  });

  test("decodes the CLI ≥ 2.1 stream-array shape (GH-1095)", () => {
    const stdout = arrayEnvelope([{ number: 42, type: "feature", confidence: "medium" }], 0.11);
    const { rows, cost } = parseHaikuEnvelope(stdout);
    expect(rows).toEqual([{ number: 42, type: "feature", confidence: "medium" }]);
    expect(cost).toBe(0.11);
  });
});

// ── runTriageTypePass — integration with mocked deps ───────────────────────

type Captured = {
  audit: TypePassAuditEntry[];
  ghCalls: Array<{ subcommand: string; args: string[] }>;
  haikuCalls: Array<{ model: string; userPrompt: string }>;
  syncCalls: number;
};

function makeDeps(
  issues: FallbackIssue[],
  haikuResponses: SpawnHaikuResult[],
  ghResults: GhExecResult[],
): { deps: TriageTypePassDeps; captured: Captured } {
  const captured: Captured = { audit: [], ghCalls: [], haikuCalls: [], syncCalls: 0 };
  let haikuIdx = 0;
  let ghIdx = 0;

  const spawnHaiku: SpawnHaiku = ({ model, userPrompt }) => {
    captured.haikuCalls.push({ model, userPrompt });
    return haikuResponses[haikuIdx++] ?? { status: 0, stdout: envelope([]), stderr: "" };
  };

  const deps: TriageTypePassDeps = {
    listOpenIssues: () => issues,
    repoNameWithOwner: () => "bdelanghe/ai-home",
    spawnHaiku,
    execGh: (opts) => {
      captured.ghCalls.push({ subcommand: opts.subcommand, args: opts.args });
      return ghResults[ghIdx++] ?? { exitCode: 0, stdout: "", stderr: "", policy: null };
    },
    now: () => FROZEN,
    auditSink: {
      stateDirOverride: "/tmp/state",
      ensureDir: () => {},
      appendFn: (_path: string, line: string) => {
        captured.audit.push(JSON.parse(line.trim()) as TypePassAuditEntry);
      },
    },
    runBeadsSync: () => {
      captured.syncCalls += 1;
      return makeZeroBeadsSyncResult();
    },
  };

  return { deps, captured };
}

describe("runTriageTypePass", () => {
  test("no candidates → no-op exit 0, no haiku, no gh, no sync", async () => {
    const { deps, captured } = makeDeps(
      [issue({ number: 1, labels: [{ name: "type::bug" }] })],
      [],
      [],
    );
    const out = makeOutput();
    const exit = await runTriageTypePass(baseOpts, out.output, deps);
    expect(exit).toBe(0);
    expect(captured.haikuCalls).toEqual([]);
    expect(captured.ghCalls).toEqual([]);
    expect(captured.syncCalls).toBe(0);
    expect(out.log[0]).toContain("no candidates");
  });

  test("dry-run path: haiku called, no gh, no sync, audit rows tagged dryRun=true", async () => {
    const issues = [
      issue({ number: 10, title: "fix: foo", labels: [{ name: "priority::high" }] }),
      issue({ number: 11, title: "feat: bar", labels: [] }),
    ];
    const haiku: SpawnHaikuResult = {
      status: 0,
      stdout: envelope([
        { number: 10, type: "bug", confidence: "high" },
        { number: 11, type: "feature", confidence: "high" },
      ]),
      stderr: "",
    };
    const { deps, captured } = makeDeps(issues, [haiku], []);
    const out = makeOutput();
    const exit = await runTriageTypePass({ ...baseOpts, dryRun: true }, out.output, deps);
    expect(exit).toBe(0);
    expect(captured.haikuCalls).toHaveLength(1);
    expect(captured.ghCalls).toEqual([]);
    expect(captured.syncCalls).toBe(0);
    const rows = captured.audit.filter((e): e is TypePassAuditRowEntry => !("action" in e));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.dryRun).toBe(true);
      expect(row.exitCode).toBe(0);
      expect(row.decisionType).toBeDefined();
      expect(row.confidence).toBeDefined();
    }
  });

  test("apply path: gh issue edit called per row, sync chained once at end", async () => {
    const issues = [
      issue({ number: 20, title: "fix: foo", labels: [{ name: "priority::low" }] }),
      issue({ number: 21, title: "feat: bar", labels: [] }),
    ];
    const haiku: SpawnHaikuResult = {
      status: 0,
      stdout: envelope([
        { number: 20, type: "bug", confidence: "high" },
        { number: 21, type: "feature", confidence: "high" },
      ]),
      stderr: "",
    };
    const ghResults: GhExecResult[] = [
      { exitCode: 0, stdout: "", stderr: "", policy: null },
      { exitCode: 0, stdout: "", stderr: "", policy: null },
    ];
    const { deps, captured } = makeDeps(issues, [haiku], ghResults);
    const out = makeOutput();
    const exit = await runTriageTypePass(baseOpts, out.output, deps);
    expect(exit).toBe(0);
    expect(captured.ghCalls).toHaveLength(2);
    expect(captured.ghCalls[0]!).toEqual({
      subcommand: "edit",
      args: ["20", "--add-label", "type::bug", "--repo", "bdelanghe/ai-home"],
    });
    expect(captured.ghCalls[1]).toEqual({
      subcommand: "edit",
      args: ["21", "--add-label", "type::feature", "--repo", "bdelanghe/ai-home"],
    });
    expect(captured.syncCalls).toBe(1);
    const sync = captured.audit.find(
      (e): e is TypePassAuditSyncEntry => "action" in e && e.action === "sync",
    );
    expect(sync).toBeDefined();
    expect(sync?.touchedIssues).toEqual([20, 21]);
  });

  test("sync skipped when touchedIssues empty (all gh writes failed)", async () => {
    const issues = [issue({ number: 30, labels: [] })];
    const haiku: SpawnHaikuResult = {
      status: 0,
      stdout: envelope([{ number: 30, type: "bug", confidence: "high" }]),
      stderr: "",
    };
    const ghResults: GhExecResult[] = [
      { exitCode: 1, stdout: "", stderr: "label not found", policy: null },
    ];
    const { deps, captured } = makeDeps(issues, [haiku], ghResults);
    const out = makeOutput();
    const exit = await runTriageTypePass(baseOpts, out.output, deps);
    expect(exit).toBe(1);
    expect(captured.syncCalls).toBe(0);
    const errorRow = captured.audit.find(
      (e): e is TypePassAuditRowEntry => !("action" in e) && e.exitCode !== 0,
    );
    expect(errorRow?.stderr).toContain("label not found");
  });

  test("haiku batch failure records one error row per candidate, no gh call", async () => {
    const issues = [issue({ number: 40, labels: [] }), issue({ number: 41, labels: [] })];
    const haiku: SpawnHaikuResult = {
      status: 1,
      stdout: "",
      stderr: "rate-limited",
    };
    const { deps, captured } = makeDeps(issues, [haiku], []);
    const out = makeOutput();
    const exit = await runTriageTypePass(baseOpts, out.output, deps);
    expect(exit).toBe(1);
    expect(captured.ghCalls).toEqual([]);
    expect(captured.syncCalls).toBe(0);
    const errs = captured.audit.filter((e): e is TypePassAuditRowEntry => !("action" in e));
    expect(errs).toHaveLength(2);
    for (const e of errs) {
      expect(e.exitCode).toBe(1);
      expect(e.stderr).toContain("haiku batch failed");
    }
  });

  test("idempotent: re-running on a typed queue is a no-op", async () => {
    // Same input as the apply test but every row already has a type label,
    // simulating a re-run after the first pass.
    const issues = [
      issue({ number: 20, labels: [{ name: "type::bug" }, { name: "priority::low" }] }),
      issue({ number: 21, labels: [{ name: "type::feature" }] }),
    ];
    const { deps, captured } = makeDeps(issues, [], []);
    const out = makeOutput();
    const exit = await runTriageTypePass(baseOpts, out.output, deps);
    expect(exit).toBe(0);
    expect(captured.haikuCalls).toEqual([]);
    expect(captured.ghCalls).toEqual([]);
    expect(captured.syncCalls).toBe(0);
  });

  test("batches respect --batch-size", async () => {
    const issues = [
      issue({ number: 50 }),
      issue({ number: 51 }),
      issue({ number: 52 }),
      issue({ number: 53 }),
      issue({ number: 54 }),
    ];
    const haikuResponses: SpawnHaikuResult[] = [
      {
        status: 0,
        stdout: envelope([
          { number: 50, type: "task", confidence: "low" },
          { number: 51, type: "task", confidence: "low" },
        ]),
        stderr: "",
      },
      {
        status: 0,
        stdout: envelope([
          { number: 52, type: "task", confidence: "low" },
          { number: 53, type: "task", confidence: "low" },
        ]),
        stderr: "",
      },
      {
        status: 0,
        stdout: envelope([{ number: 54, type: "task", confidence: "low" }]),
        stderr: "",
      },
    ];
    const { deps, captured } = makeDeps(issues, haikuResponses, []);
    const out = makeOutput();
    const exit = await runTriageTypePass(
      { ...baseOpts, batchSize: 2, dryRun: true },
      out.output,
      deps,
    );
    expect(exit).toBe(0);
    expect(captured.haikuCalls).toHaveLength(3);
  });

  test("GH-988 + GH-1489: spike-bit emission stamps type::spike alongside the bd-axis type", async () => {
    const issues = [
      issue({ number: 70, title: "spike: investigate notion", labels: [] }),
      issue({ number: 71, title: "fix: regression", labels: [] }),
    ];
    const haiku: SpawnHaikuResult = {
      status: 0,
      stdout: envelope([
        { number: 70, type: "task", spike: true, confidence: "high" },
        { number: 71, type: "bug", spike: false, confidence: "high" },
      ]),
      stderr: "",
    };
    const ghResults: GhExecResult[] = [
      { exitCode: 0, stdout: "", stderr: "", policy: null },
      { exitCode: 0, stdout: "", stderr: "", policy: null },
    ];
    const { deps, captured } = makeDeps(issues, [haiku], ghResults);
    const out = makeOutput();
    const exit = await runTriageTypePass(baseOpts, out.output, deps);
    expect(exit).toBe(0);
    // Spike-bit row stamps both labels; non-spike row stamps just the bd-axis.
    expect(captured.ghCalls[0]!).toEqual({
      subcommand: "edit",
      args: ["70", "--add-label", "type::task,type::spike", "--repo", "bdelanghe/ai-home"],
    });
    expect(captured.ghCalls[1]).toEqual({
      subcommand: "edit",
      args: ["71", "--add-label", "type::bug", "--repo", "bdelanghe/ai-home"],
    });
    const rows = captured.audit.filter((e): e is TypePassAuditRowEntry => !("action" in e));
    expect(rows.find((r) => r.issue === 70)?.decisionSpike).toBe(true);
    expect(rows.find((r) => r.issue === 71)?.decisionSpike).toBe(false);
  });

  test("haiku omits a row → audit row marks omission as error, others apply", async () => {
    const issues = [issue({ number: 60, labels: [] }), issue({ number: 61, labels: [] })];
    const haiku: SpawnHaikuResult = {
      status: 0,
      stdout: envelope([{ number: 60, type: "bug", confidence: "high" }]),
      stderr: "",
    };
    const ghResults: GhExecResult[] = [{ exitCode: 0, stdout: "", stderr: "", policy: null }];
    const { deps, captured } = makeDeps(issues, [haiku], ghResults);
    const out = makeOutput();
    const exit = await runTriageTypePass(baseOpts, out.output, deps);
    expect(exit).toBe(1);
    expect(captured.ghCalls).toHaveLength(1);
    expect(captured.ghCalls[0]!.args[0]!).toBe("60");
    const omitted = captured.audit.find(
      (e): e is TypePassAuditRowEntry => !("action" in e) && e.issue === 61 && e.exitCode !== 0,
    );
    expect(omitted?.stderr).toContain("haiku omitted");
    expect(captured.syncCalls).toBe(1);
  });
});
