// GH-1047 — `prx triage prioritize-bulk` unit tests. Mirrors the dependency-
// injection patterns from prioritize.test.ts.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  BULK_PRIORITY_SYSTEM_PROMPT,
  chunkIntoBatches,
  runTriagePrioritizeBulk,
  selectCandidates,
  type Candidate,
  type CasPort,
  type ClaudeRunner,
  type TriagePrioritizeBulkDeps,
} from "../../src/triage/prioritize-bulk.ts";
import type { GhExecResult } from "@bounded-systems/gh";
import type { FallbackIssue } from "../../src/pr-state/github.ts";
import { prioritizeBulkAuditRowSchema } from "../../src/triage/schemas/index.ts";
import { makeRunBeadsSyncMock } from "./sync-mock.ts";

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

const ZERO_SYNC = { exitCode: 0, stdout: "", stderr: "" };

// In-memory CAS port: hashes with the same sha256 the real store uses, so
// `casUriFor` produces a valid `scout://sha256:<hex>` handle, but never
// touches the operator's on-disk CAS during tests. `reads` records every
// readBlob sha so a test can assert the orchestrator re-reads its own blob.
function makeFakeCas(): CasPort & {
  writes: () => Array<{ domain: string | undefined; content: string }>;
  reads: () => string[];
} {
  const store = new Map<string, Buffer>();
  const writes: Array<{ domain: string | undefined; content: string }> = [];
  const reads: string[] = [];
  return {
    writeBlob: async (content, opts) => {
      const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
      writes.push({ domain: opts?.domain, content: buf.toString("utf8") });
      const sha = `sha256:${createHash("sha256").update(buf).digest("hex")}`;
      store.set(sha, buf);
      return { sha };
    },
    readBlob: async (sha) => {
      reads.push(sha);
      const buf = store.get(sha);
      if (!buf) throw new Error(`fake cas: blob not found: ${sha}`);
      return buf;
    },
    writes: () => writes,
    reads: () => reads,
  };
}

type ScriptedDecision = {
  number: number;
  decision: "critical" | "high" | "medium" | "low";
  confidence?: "high" | "medium" | "low";
};

function scriptClaude(
  batches: ScriptedDecision[][],
  costPerBatch = 0.04,
  shape: "object" | "array" = "object",
): { runner: ClaudeRunner; calls: () => Array<{ batchSize: number; userPrompt: string }> } {
  const calls: Array<{ batchSize: number; userPrompt: string }> = [];
  let i = 0;
  const runner: ClaudeRunner = ({ userPrompt }) => {
    const parsed = JSON.parse(userPrompt) as Array<{ number: number }>;
    calls.push({ batchSize: parsed.length, userPrompt });
    const decisions = batches[i] ?? [];
    i += 1;
    const result = JSON.stringify(decisions);
    const stdout =
      shape === "array"
        ? JSON.stringify([
            { type: "system", subtype: "init", session_id: "s1", cwd: "/t" },
            { type: "assistant", message: {} },
            {
              type: "result",
              subtype: "success",
              is_error: false,
              result,
              total_cost_usd: costPerBatch,
            },
          ])
        : JSON.stringify({
            type: "result",
            result,
            total_cost_usd: costPerBatch,
          });
    return {
      exitCode: 0,
      stdout,
      stderr: "",
    };
  };
  return { runner, calls: () => calls };
}

function setup(opts: {
  issues: FallbackIssue[];
  scripted: ScriptedDecision[][];
  execResults?: GhExecResult[];
  syncResult?: { exitCode: number; stdout: string; stderr: string };
  claudeRunner?: ClaudeRunner;
}) {
  const audit: string[] = [];
  const calls: Array<{ group: string; sub: string; args: string[] }> = [];
  let execIndex = 0;
  let syncCalls = 0;
  const { runner: scriptedRunner, calls: claudeCalls } = scriptClaude(opts.scripted);
  const cas = makeFakeCas();
  const deps: TriagePrioritizeBulkDeps = {
    cas,
    execGh: (eopts) => {
      calls.push({ group: eopts.group, sub: eopts.subcommand, args: eopts.args });
      const res =
        opts.execResults?.[execIndex] ??
        ({ exitCode: 0, stdout: "", stderr: "", policy: null } as GhExecResult);
      execIndex += 1;
      return res;
    },
    listOpenIssues: () => opts.issues,
    repoNameWithOwner: () => "bdelanghe/ai-home",
    runClaude: opts.claudeRunner ?? scriptedRunner,
    now: () => new Date("2026-04-29T10:00:00Z"),
    auditSink: {
      stateDirOverride: "/tmp/state",
      ensureDir: () => {},
      appendFn: (_p: string, line: string) => audit.push(line),
    },
    // GH-2316: status-only canonical reconcile seam (replaces the retired
    // destructive `bd github sync --pull-only --prefer-github` shell-out).
    runBeadsSync: makeRunBeadsSyncMock(opts.syncResult ?? ZERO_SYNC, () => {
      syncCalls += 1;
    }),
    generateBatchId: (i) => `batch-${i}`,
  };
  const o = makeOutput();
  return { audit, calls, o, deps, claudeCalls, cas, syncCalls: () => syncCalls };
}

const baseOpts = {
  repo: "bdelanghe/ai-home",
  model: "claude-haiku-4-5-20251001",
  batchSize: 30,
  limit: 0,
  dryRun: false,
};

// ── selectCandidates parity with prioritize.ts ────────────────────────────

describe("selectCandidates", () => {
  test("includes priority::none rows", () => {
    const c = selectCandidates([issue({ number: 1, labels: [{ name: "priority::none" }] })]);
    expect(c).toHaveLength(1);
    expect(c[0]!.hasPriorityNone).toBe(true);
  });

  test("includes rows with no priority axis label at all", () => {
    const c = selectCandidates([issue({ number: 2, labels: [{ name: "type::feature" }] })]);
    expect(c).toHaveLength(1);
    expect(c[0]!.hasPriorityNone).toBe(false);
  });

  test("excludes rows with a scored priority label (idempotency / GH-957 gate)", () => {
    const c = selectCandidates([
      issue({ number: 3, labels: [{ name: "priority::high" }] }),
      issue({ number: 4, labels: [{ name: "priority::medium" }, { name: "type::bug" }] }),
    ]);
    expect(c).toEqual([]);
  });

  test("sorts ascending for stable batch order", () => {
    const c = selectCandidates([
      issue({ number: 9, labels: [{ name: "priority::none" }] }),
      issue({ number: 1, labels: [] }),
      issue({ number: 5, labels: [{ name: "priority::none" }] }),
    ]);
    expect(c.map((x) => x.number)).toEqual([1, 5, 9]);
  });
});

describe("chunkIntoBatches", () => {
  test("65 candidates @ batchSize 30 → [30, 30, 5]", () => {
    const items = Array.from({ length: 65 }, (_, i) => i);
    const chunks = chunkIntoBatches(items, 30);
    expect(chunks.map((c) => c.length)).toEqual([30, 30, 5]);
  });

  test("empty input → []", () => {
    expect(chunkIntoBatches([], 30)).toEqual([]);
  });

  test("rejects non-positive batchSize", () => {
    expect(() => chunkIntoBatches([1], 0)).toThrow();
    expect(() => chunkIntoBatches([1], -1)).toThrow();
  });
});

describe("BULK_PRIORITY_SYSTEM_PROMPT", () => {
  test("encodes the 8-rule heuristic + JSON-only output instruction", () => {
    expect(BULK_PRIORITY_SYSTEM_PROMPT).toContain("ONLY a JSON array");
    expect(BULK_PRIORITY_SYSTEM_PROMPT).toContain("critical");
    expect(BULK_PRIORITY_SYSTEM_PROMPT).toContain("Epics ([epic]");
    expect(BULK_PRIORITY_SYSTEM_PROMPT).toContain("TUI/UI polish bugs");
    expect(BULK_PRIORITY_SYSTEM_PROMPT).toContain("Uncertain medium-vs-high");
  });
});

// ── orchestrator behavior ─────────────────────────────────────────────────

describe("runTriagePrioritizeBulk", () => {
  test("empty queue → exit 0, no claude call, no gh call, friendly log", async () => {
    const { o, deps, calls, claudeCalls, syncCalls } = setup({
      issues: [issue({ number: 1, labels: [{ name: "priority::high" }] })],
      scripted: [],
    });
    const code = await runTriagePrioritizeBulk(baseOpts, o.output, deps);
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(claudeCalls()).toHaveLength(0);
    expect(syncCalls()).toBe(0);
    expect(o.log.join("\n")).toContain("no candidates");
  });

  test("idempotent re-run: all-prioritized queue is a no-op", async () => {
    const { o, deps, calls, syncCalls } = setup({
      issues: [
        issue({ number: 1, labels: [{ name: "priority::critical" }] }),
        issue({ number: 2, labels: [{ name: "priority::low" }, { name: "type::task" }] }),
      ],
      scripted: [],
    });
    const code = await runTriagePrioritizeBulk(baseOpts, o.output, deps);
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(syncCalls()).toBe(0);
  });

  test("65 candidates @ batchSize 30 → claude called 3× with sizes [30, 30, 5]", async () => {
    const issues = Array.from({ length: 65 }, (_, i) =>
      issue({ number: i + 1, labels: [{ name: "priority::none" }] }),
    );
    const decisionsBatch = (start: number, count: number): ScriptedDecision[] =>
      Array.from({ length: count }, (_, i) => ({
        number: start + i,
        decision: "medium",
        confidence: "high",
      }));
    const { o, deps, claudeCalls, calls } = setup({
      issues,
      scripted: [decisionsBatch(1, 30), decisionsBatch(31, 30), decisionsBatch(61, 5)],
    });
    const code = await runTriagePrioritizeBulk({ ...baseOpts, batchSize: 30 }, o.output, deps);
    expect(code).toBe(0);
    const c = claudeCalls();
    expect(c.map((x) => x.batchSize)).toEqual([30, 30, 5]);
    expect(calls).toHaveLength(65);
  });

  test("apply path: each decision → one issue/edit with --add-label, --remove-label, --repo (no raw gh strings)", async () => {
    const { o, deps, calls } = setup({
      issues: [
        issue({ number: 11, labels: [{ name: "priority::none" }, { name: "needs-triage" }] }),
        issue({ number: 22, labels: [{ name: "type::feature" }] }),
      ],
      scripted: [
        [
          { number: 11, decision: "high", confidence: "medium" },
          { number: 22, decision: "low", confidence: "high" },
        ],
      ],
    });
    const code = await runTriagePrioritizeBulk(baseOpts, o.output, deps);
    expect(code).toBe(0);
    expect(calls).toHaveLength(2);

    expect(calls[0]!.group).toBe("issue");
    expect(calls[0]!.sub).toBe("edit");
    expect(calls[0]!.args[0]!).toBe("11");
    expect(calls[0]!.args).toContain("--add-label");
    expect(calls[0]!.args).toContain("priority::high");
    expect(calls[0]!.args).toContain("--remove-label");
    // GH-1396: full-axis strip from canonical vocab, not just priority::none.
    expect(calls[0]!.args).toContain(
      "priority::critical,priority::medium,priority::low,priority::none",
    );
    expect(calls[0]!.args).toContain("--repo");
    expect(calls[0]!.args).toContain("bdelanghe/ai-home");

    // GH-22 had no priority axis label at all, but the new contract still
    // emits the full strip set so the write is authoritative on the axis.
    // gh issue edit --remove-label no-ops on absent labels.
    expect(calls[1]!.args[0]!).toBe("22");
    expect(calls[1]!.args).toContain("--add-label");
    expect(calls[1]!.args).toContain("priority::low");
    expect(calls[1]!.args).toContain("--remove-label");
    expect(calls[1]!.args).toContain(
      "priority::critical,priority::high,priority::medium,priority::none",
    );
  });

  test("dry-run: per-row decision printed, audit dryRun:true, no gh writes, no sync", async () => {
    const { o, deps, calls, syncCalls, audit } = setup({
      issues: [issue({ number: 5, labels: [{ name: "priority::none" }] })],
      scripted: [[{ number: 5, decision: "medium", confidence: "low" }]],
    });
    const code = await runTriagePrioritizeBulk({ ...baseOpts, dryRun: true }, o.output, deps);
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(syncCalls()).toBe(0);
    expect(o.log.join("\n")).toContain("dry-run GH-5");
    const entry = JSON.parse(audit[0]!);
    expect(entry.dryRun).toBe(true);
    expect(entry.decision).toBe("medium");
    expect(entry.confidence).toBe("low");
  });

  test("audit JSONL boundary: every row passes prioritizeBulkAuditRowSchema.parse", async () => {
    const { o, deps, audit } = setup({
      issues: [
        issue({ number: 1, labels: [{ name: "priority::none" }] }),
        issue({ number: 2, labels: [{ name: "type::feature" }] }),
      ],
      scripted: [
        [
          { number: 1, decision: "critical", confidence: "high" },
          { number: 2, decision: "low" }, // confidence omitted → optional
        ],
      ],
    });
    const code = await runTriagePrioritizeBulk(baseOpts, o.output, deps);
    expect(code).toBe(0);
    for (const line of audit) {
      const parsed = JSON.parse(line);
      expect(() => prioritizeBulkAuditRowSchema.parse(parsed)).not.toThrow();
    }
  });

  test("Haiku malformed wrapper → batch error, all rows in batch get error audit, exit 1", async () => {
    const malformedRunner: ClaudeRunner = () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        type: "result",
        result: "not json",
        total_cost_usd: 0.04,
      }),
      stderr: "",
    });
    const { o, deps, calls, audit } = setup({
      issues: [
        issue({ number: 1, labels: [{ name: "priority::none" }] }),
        issue({ number: 2, labels: [{ name: "priority::none" }] }),
      ],
      scripted: [],
      claudeRunner: malformedRunner,
    });
    const code = await runTriagePrioritizeBulk(baseOpts, o.output, deps);
    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(audit).toHaveLength(2);
    for (const line of audit) {
      const entry = JSON.parse(line);
      expect(entry.exitCode).toBe(1);
      expect(entry.decision).toBeUndefined();
      expect(entry.stderr).toBeTruthy();
    }
  });

  test("Haiku stream-array envelope (CLI ≥ 2.1, GH-1095) decodes the same as the legacy object shape", async () => {
    const { runner } = scriptClaude(
      [[{ number: 9, decision: "high", confidence: "medium" }]],
      0.07,
      "array",
    );
    const { o, deps, calls, audit } = setup({
      issues: [issue({ number: 9, labels: [{ name: "priority::none" }] })],
      scripted: [],
      claudeRunner: runner,
    });
    const code = await runTriagePrioritizeBulk(baseOpts, o.output, deps);
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    const entry = JSON.parse(audit[0]!);
    expect(entry.decision).toBe("high");
    expect(entry.cost).toBe(0.07);
  });

  test("Haiku output wrapped in ```json fence is stripped before JSON.parse (GH-1169 parity with type-pass)", async () => {
    const fenceRunner: ClaudeRunner = () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        type: "result",
        result:
          "```json\n" +
          JSON.stringify([{ number: 5, decision: "high", confidence: "medium" }]) +
          "\n```",
        total_cost_usd: 0.03,
      }),
      stderr: "",
    });
    const { o, deps, audit } = setup({
      issues: [issue({ number: 5, labels: [{ name: "priority::none" }] })],
      scripted: [],
      claudeRunner: fenceRunner,
    });
    const code = await runTriagePrioritizeBulk(baseOpts, o.output, deps);
    expect(code).toBe(0);
    const entry = JSON.parse(audit[0]!);
    expect(entry.decision).toBe("high");
  });

  test("Haiku invalid decision enum → ZodError surfaces as batch error", async () => {
    const invalidRunner: ClaudeRunner = () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        type: "result",
        result: JSON.stringify([{ number: 1, decision: "URGENT" }]),
        total_cost_usd: 0,
      }),
      stderr: "",
    });
    const { o, deps, audit } = setup({
      issues: [issue({ number: 1, labels: [{ name: "priority::none" }] })],
      scripted: [],
      claudeRunner: invalidRunner,
    });
    const code = await runTriagePrioritizeBulk(baseOpts, o.output, deps);
    expect(code).toBe(1);
    expect(audit).toHaveLength(1);
    const entry = JSON.parse(audit[0]!);
    expect(entry.exitCode).toBe(1);
  });

  test("gh issue-edit error → exit 1, audit row records exitCode + stderr", async () => {
    const { o, deps, audit } = setup({
      issues: [issue({ number: 7, labels: [{ name: "priority::none" }] })],
      scripted: [[{ number: 7, decision: "critical", confidence: "high" }]],
      execResults: [{ exitCode: 1, stdout: "", stderr: "rate limit exceeded", policy: null }],
    });
    const code = await runTriagePrioritizeBulk(baseOpts, o.output, deps);
    expect(code).toBe(1);
    const entry = JSON.parse(audit[0]!);
    expect(entry.exitCode).toBe(1);
    expect(entry.stderr).toBe("rate limit exceeded");
    expect(entry.decision).toBe("critical");
  });

  test("non-dry-run with writes triggers bd github sync exactly once", async () => {
    const { o, deps, syncCalls } = setup({
      issues: [
        issue({ number: 1, labels: [{ name: "priority::none" }] }),
        issue({ number: 2, labels: [{ name: "priority::none" }] }),
      ],
      scripted: [
        [
          { number: 1, decision: "medium" },
          { number: 2, decision: "high" },
        ],
      ],
      syncResult: { exitCode: 0, stdout: "synced 2 issues", stderr: "" },
    });
    const code = await runTriagePrioritizeBulk(baseOpts, o.output, deps);
    expect(code).toBe(0);
    expect(syncCalls()).toBe(1);
    expect(o.log.join("\n")).toContain("OK bd github sync: 2 issue(s) reconciled");
    expect(o.log.join("\n")).toContain("sync=ok");
  });

  test("dry-run suppresses bd github sync regardless of writes", async () => {
    const { o, deps, syncCalls } = setup({
      issues: [issue({ number: 1, labels: [{ name: "priority::none" }] })],
      scripted: [[{ number: 1, decision: "medium" }]],
    });
    const code = await runTriagePrioritizeBulk({ ...baseOpts, dryRun: true }, o.output, deps);
    expect(code).toBe(0);
    expect(syncCalls()).toBe(0);
    expect(o.log.join("\n")).toContain("sync=skipped");
  });

  test("zero-write batch (all rows fail at gh layer) suppresses bd github sync", async () => {
    const { o, deps, syncCalls } = setup({
      issues: [issue({ number: 7, labels: [{ name: "priority::none" }] })],
      scripted: [[{ number: 7, decision: "high" }]],
      execResults: [{ exitCode: 1, stdout: "", stderr: "boom", policy: null }],
    });
    const code = await runTriagePrioritizeBulk(baseOpts, o.output, deps);
    expect(code).toBe(1);
    expect(syncCalls()).toBe(0);
    expect(o.log.join("\n")).toContain("sync=skipped");
  });

  test("sync failure flips exit to 1", async () => {
    const { o, deps, syncCalls } = setup({
      issues: [issue({ number: 1, labels: [{ name: "priority::none" }] })],
      scripted: [[{ number: 1, decision: "medium" }]],
      syncResult: { exitCode: 2, stdout: "", stderr: "bd: token expired" },
    });
    const code = await runTriagePrioritizeBulk(baseOpts, o.output, deps);
    expect(code).toBe(1);
    expect(syncCalls()).toBe(1);
    expect(o.log.join("\n")).toContain("sync=failed");
    expect(o.error.join("\n")).toContain("FAIL bd github sync");
  });

  test("--limit caps candidates after filtering and before batching", async () => {
    const issues = Array.from({ length: 5 }, (_, i) =>
      issue({ number: i + 1, labels: [{ name: "priority::none" }] }),
    );
    const { o, deps, calls } = setup({
      issues,
      scripted: [
        [
          { number: 1, decision: "medium" },
          { number: 2, decision: "medium" },
        ],
      ],
    });
    const code = await runTriagePrioritizeBulk({ ...baseOpts, limit: 2 }, o.output, deps);
    expect(code).toBe(0);
    expect(calls.map((c) => c.args[0]!)).toEqual(["1", "2"]);
  });

  test("--repo option overrides repoNameWithOwner; --repo arg flows through", async () => {
    const { o, deps, calls } = setup({
      issues: [issue({ number: 1, labels: [{ name: "priority::none" }] })],
      scripted: [[{ number: 1, decision: "medium" }]],
    });
    const code = await runTriagePrioritizeBulk({ ...baseOpts, repo: "other/repo" }, o.output, deps);
    expect(code).toBe(0);
    expect(calls[0]!.args).toContain("other/repo");
  });

  test("falls back to repoNameWithOwner when --repo undefined", async () => {
    const { o, deps, calls } = setup({
      issues: [issue({ number: 1, labels: [{ name: "priority::none" }] })],
      scripted: [[{ number: 1, decision: "medium" }]],
    });
    const code = await runTriagePrioritizeBulk({ ...baseOpts, repo: undefined }, o.output, deps);
    expect(code).toBe(0);
    expect(calls[0]!.args).toContain("bdelanghe/ai-home");
  });

  // ── GH-1396: full priority-axis strip ────────────────────────────────────
  //
  // Regression — prior to GH-1396 the bulk write only stripped `priority::none`
  // when `candidate.hasPriorityNone` was true. That stale-snapshot contract
  // races with `prx triage classify --apply` (GH-1487, which upgrades
  // `priority::none → priority::high` mid-drain): by the time the bulk write
  // runs, `priority::high` already exists on the issue, but the snapshot still
  // reads `priority::none`, so `--remove-label priority::none` no-ops and the
  // bulk add lands on top of the surviving `priority::high`. Stripping the
  // full canonical priority vocab minus the target is race-free.

  test("GH-1396 race regression: snapshot says priority::none, live GH has a different priority::* — full-axis strip still removes it", async () => {
    // Simulates the race: the in-memory candidate carries the *stale*
    // snapshot (`priority::none`) but live GH already has `priority::high`
    // (added by `apply`). The orchestrator must emit a strip that covers
    // every non-target priority value so the live state converges to one
    // priority label regardless of snapshot freshness.
    const { o, deps, calls } = setup({
      issues: [issue({ number: 1396, labels: [{ name: "priority::none" }] })],
      scripted: [[{ number: 1396, decision: "medium", confidence: "high" }]],
    });
    const code = await runTriagePrioritizeBulk(baseOpts, o.output, deps);
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toContain("--add-label");
    expect(calls[0]!.args).toContain("priority::medium");
    expect(calls[0]!.args).toContain("--remove-label");
    // Full vocab minus target. PRIORITY enum order is critical/high/medium/low/none
    // ⇒ filtered minus `medium` ⇒ critical,high,low,none.
    expect(calls[0]!.args).toContain(
      "priority::critical,priority::high,priority::low,priority::none",
    );
  });

  test("GH-1396 idempotent strip: candidate has only priority::none → strip set still spans full vocab minus target", async () => {
    const { o, deps, calls } = setup({
      issues: [issue({ number: 1, labels: [{ name: "priority::none" }] })],
      scripted: [[{ number: 1, decision: "medium" }]],
    });
    const code = await runTriagePrioritizeBulk(baseOpts, o.output, deps);
    expect(code).toBe(0);
    const removeIdx = calls[0]!.args.indexOf("--remove-label");
    expect(removeIdx).toBeGreaterThanOrEqual(0);
    const removeArg = calls[0]!.args[removeIdx + 1]!;
    expect(removeArg.split(",").sort()).toEqual([
      "priority::critical",
      "priority::high",
      "priority::low",
      "priority::none",
    ]);
  });

  test("GH-1396 no-axis baseline: candidate has empty labels → strip is still emitted (no-op on GH for absent labels)", async () => {
    const { o, deps, calls } = setup({
      issues: [issue({ number: 2, labels: [] })],
      scripted: [[{ number: 2, decision: "low" }]],
    });
    const code = await runTriagePrioritizeBulk(baseOpts, o.output, deps);
    expect(code).toBe(0);
    expect(calls[0]!.args).toContain("--add-label");
    expect(calls[0]!.args).toContain("priority::low");
    expect(calls[0]!.args).toContain("--remove-label");
    // gh issue edit --remove-label no-ops on absent labels, so emitting the
    // full strip set here is safe and locks in the new contract.
    expect(calls[0]!.args).toContain(
      "priority::critical,priority::high,priority::medium,priority::none",
    );
  });

  test("GH-1396 dry-run mirror: dry-run log line includes the full strip set, audit row stays dryRun:true", async () => {
    const { o, deps, calls, audit } = setup({
      issues: [issue({ number: 1396, labels: [{ name: "priority::none" }] })],
      scripted: [[{ number: 1396, decision: "medium", confidence: "high" }]],
    });
    const code = await runTriagePrioritizeBulk({ ...baseOpts, dryRun: true }, o.output, deps);
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    const logLine = o.log.find((l) => l.startsWith("dry-run GH-1396"));
    expect(logLine).toBeDefined();
    expect(logLine).toContain("-priority::critical,priority::high,priority::low,priority::none");
    expect(logLine).toContain("+priority::medium");
    const entry = JSON.parse(audit[0]!);
    expect(entry.dryRun).toBe(true);
    expect(entry.decision).toBe("medium");
  });

  test("Haiku returns issue number not in batch → logged but does not fail run", async () => {
    const ghostRunner: ClaudeRunner = () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        type: "result",
        result: JSON.stringify([
          { number: 1, decision: "medium" },
          { number: 9999, decision: "low" }, // ghost
        ]),
        total_cost_usd: 0,
      }),
      stderr: "",
    });
    const { o, deps, calls } = setup({
      issues: [issue({ number: 1, labels: [{ name: "priority::none" }] })],
      scripted: [],
      claudeRunner: ghostRunner,
    });
    const code = await runTriagePrioritizeBulk(baseOpts, o.output, deps);
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0]!).toBe("1");
    expect(o.error.join("\n")).toContain("returned unknown issue 9999");
  });

  // ── GH-1384: scout CAS provenance for the input batch ─────────────────────

  test("each batch is materialized to the scout CAS domain and re-read before dispatch; the handle lands on every audit row", async () => {
    const { o, deps, audit, cas, claudeCalls } = setup({
      issues: [
        issue({ number: 1, labels: [{ name: "priority::none" }] }),
        issue({ number: 2, labels: [{ name: "type::feature" }] }),
      ],
      scripted: [
        [
          { number: 1, decision: "high", confidence: "medium" },
          { number: 2, decision: "low", confidence: "high" },
        ],
      ],
    });
    const code = await runTriagePrioritizeBulk(baseOpts, o.output, deps);
    expect(code).toBe(0);

    // One write to the scout domain carrying the validated raw-JSON-array input.
    const writes = cas.writes();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.domain).toBe("scout");
    const written = JSON.parse(writes[0]!.content) as Array<{
      number: number;
      title: string;
      currentLabels: string[];
    }>;
    expect(written.map((r) => r.number)).toEqual([1, 2]);

    // Orchestrator re-reads its own blob; the bytes that reach the classifier
    // are the round-tripped content (byte-identical to the written batch).
    expect(cas.reads()).toHaveLength(1);
    expect(claudeCalls()[0]!.userPrompt).toBe(writes[0]!.content);

    // Every decision row carries the scout://sha256:<hex> handle.
    const expectedSha = createHash("sha256")
      .update(Buffer.from(writes[0]!.content, "utf8"))
      .digest("hex");
    const expectedHandle = `scout://sha256:${expectedSha}`;
    expect(audit).toHaveLength(2);
    for (const line of audit) {
      const entry = JSON.parse(line);
      expect(entry.casHandle).toBe(expectedHandle);
    }
  });
});
