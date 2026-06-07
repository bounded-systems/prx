import { describe, expect, test } from "bun:test";

import {
  runTriageCloseStale,
  triageCloseStaleOptionsSchema,
} from "../../src/triage/close-stale.ts";
import type { BdExecResult } from "@bounded-systems/bd";
import type { StaleRow } from "../../src/triage/triage.ts";
import { auditRowSchema } from "../../src/triage/schemas/audit.ts";

function stale(overrides: Partial<StaleRow> = {}): StaleRow {
  return {
    beadsId: "ai-home-stale1",
    issueNumber: 100,
    url: "https://github.com/bdelanghe/ai-home/issues/100",
    title: "stale bead",
    status: "open",
    priority: "medium",
    issueType: "task",
    reason: "gh-issue-closed",
    ...overrides,
  };
}

function makeOutput() {
  const log: string[] = [];
  const error: string[] = [];
  return {
    output: {
      log: (line: string) => log.push(line),
      error: (line: string) => error.push(line),
    },
    log,
    error,
  };
}

type BdCall = { subcommand: string; args: string[]; state?: string; role?: string };

// GH-296 / prx-82b: the close write now runs `prx beads close <id> --reason …`
// through the daemon (a sync runner), not host `bd update`. The fake runner
// records the equivalent old `{subcommand, args, state, role}` shape so the
// existing call assertions hold; `bdResults` still drives failure injection
// (exitCode → process status).
function makeRun(results: BdExecResult[] = []) {
  const calls: BdCall[] = [];
  let idx = 0;
  const run = (cmd: string[], _opts?: { check?: boolean }) => {
    // cmd = ["prx","beads","close", <id>, "--reason", <note>]
    const id = cmd[3] ?? "";
    const note = cmd[5] ?? "";
    calls.push({
      subcommand: "update",
      args: [id, "-s", "closed", "--notes", note],
      state: "planning",
      role: "planner",
    });
    const result = results[idx] ?? { exitCode: 0, stdout: "", stderr: "", policy: null };
    idx += 1;
    return { status: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  };
  return { run, calls };
}

const NOW = new Date("2026-05-15T00:00:00.000Z");

function makeDeps(opts: {
  staleRows: StaleRow[];
  bdResults?: BdExecResult[];
  canonical?: "gh" | "bd";
  audit?: string[];
}) {
  const { run, calls } = makeRun(opts.bdResults ?? []);
  const audit = opts.audit ?? [];
  const invalidations: number[] = [];
  return {
    deps: {
      run: run as never,
      now: () => NOW,
      findStale: () => ({
        repo: "bdelanghe/ai-home",
        canonical: opts.canonical ?? "gh",
        rows: opts.staleRows,
      }),
      auditSink: {
        stateDirOverride: "/tmp/state",
        ensureDir: () => {},
        appendFn: (_path: string, line: string) => audit.push(line),
      },
      invalidateBeadsCache: () => invalidations.push(invalidations.length),
    } as never,
    calls,
    audit,
    invalidations,
  };
}

function parseAudit(lines: string[]): unknown[] {
  return lines.map((l) => JSON.parse(l));
}

describe("triageCloseStaleOptionsSchema", () => {
  test("default reason is 'completed'", () => {
    const parsed = triageCloseStaleOptionsSchema.parse({});
    expect(parsed.reason).toBe("completed");
  });
});

describe("runTriageCloseStale", () => {
  test("empty stale set: no bd writes, summary line writes=0", () => {
    const { deps, calls, audit } = makeDeps({ staleRows: [] });
    const { output, log, error } = makeOutput();
    const result = runTriageCloseStale(
      triageCloseStaleOptionsSchema.parse({}),
      output,
      deps,
    );
    expect(result.writes).toBe(0);
    expect(result.errors).toBe(0);
    expect(calls).toHaveLength(0);
    expect(audit).toHaveLength(0);
    expect(error).toHaveLength(0);
    expect(log.some((l) => l.startsWith("triage close-stale: writes=0"))).toBe(true);
  });

  test("dry-run: emits one audit row per stale bead with dryRun=true, no bd writes", () => {
    const rows = [
      stale({ beadsId: "ai-home-a", issueNumber: 100 }),
      stale({ beadsId: "ai-home-b", issueNumber: 200 }),
    ];
    const { deps, calls, audit } = makeDeps({ staleRows: rows });
    const { output } = makeOutput();
    const result = runTriageCloseStale(
      triageCloseStaleOptionsSchema.parse({ dryRun: true }),
      output,
      deps,
    );
    expect(result.writes).toBe(2);
    expect(result.errors).toBe(0);
    expect(calls).toHaveLength(0);
    const parsed = parseAudit(audit) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.dryRun).toBe(true);
    expect(parsed[0]?.action).toBe("update");
    expect(parsed[0]?.reason).toBe("completed");
    expect(result.rows[0]?.dryRun).toBe(true);
    expect(result.rows[0]?.closed).toBe(false);
  });

  test("happy path: closes each row via bd update -s closed --notes …, invalidates cache", () => {
    const rows = [
      stale({ beadsId: "ai-home-a", issueNumber: 100 }),
      stale({ beadsId: "ai-home-b", issueNumber: 200 }),
    ];
    const { deps, calls, audit, invalidations } = makeDeps({ staleRows: rows });
    const { output } = makeOutput();
    const result = runTriageCloseStale(
      triageCloseStaleOptionsSchema.parse({}),
      output,
      deps,
    );
    expect(result.writes).toBe(2);
    expect(result.errors).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.subcommand).toBe("update");
    expect(calls[0]?.args.slice(0, 4)).toEqual([
      "ai-home-a",
      "-s",
      "closed",
      "--notes",
    ]);
    expect(calls[0]?.args[4]).toBe(
      "closed via prx triage close-stale (reason=completed)",
    );
    expect(calls[0]?.state).toBe("planning");
    expect(calls[0]?.role).toBe("planner");
    expect(invalidations).toHaveLength(2);
    const parsed = parseAudit(audit) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.action).toBe("update");
    expect(parsed[0]?.dryRun).toBe(false);
    expect(parsed[0]?.exitCode).toBe(0);
  });

  test("--reason not-planned overrides default and appears in note + audit", () => {
    const rows = [stale({ beadsId: "ai-home-a", issueNumber: 100 })];
    const { deps, calls, audit } = makeDeps({ staleRows: rows });
    const { output } = makeOutput();
    runTriageCloseStale(
      triageCloseStaleOptionsSchema.parse({ reason: "not-planned" }),
      output,
      deps,
    );
    expect(calls[0]?.args[4]).toBe(
      "closed via prx triage close-stale (reason=not-planned)",
    );
    const parsed = parseAudit(audit) as Array<Record<string, unknown>>;
    expect(parsed[0]?.reason).toBe("not-planned");
  });

  test("--reason duplicate overrides default", () => {
    const rows = [stale()];
    const { deps, calls, audit } = makeDeps({ staleRows: rows });
    const { output } = makeOutput();
    runTriageCloseStale(
      triageCloseStaleOptionsSchema.parse({ reason: "duplicate" }),
      output,
      deps,
    );
    expect(calls[0]?.args[4]).toBe(
      "closed via prx triage close-stale (reason=duplicate)",
    );
    const parsed = parseAudit(audit) as Array<Record<string, unknown>>;
    expect(parsed[0]?.reason).toBe("duplicate");
  });

  test("--note concatenates after the reason prefix", () => {
    const rows = [stale()];
    const { deps, calls } = makeDeps({ staleRows: rows });
    const { output } = makeOutput();
    runTriageCloseStale(
      triageCloseStaleOptionsSchema.parse({ note: "PR-1500 shipped" }),
      output,
      deps,
    );
    expect(calls[0]?.args[4]).toBe(
      "closed via prx triage close-stale (reason=completed): PR-1500 shipped",
    );
  });

  test("--limit 1: only first row processed", () => {
    const rows = [
      stale({ beadsId: "ai-home-a", issueNumber: 100 }),
      stale({ beadsId: "ai-home-b", issueNumber: 200 }),
    ];
    const { deps, calls } = makeDeps({ staleRows: rows });
    const { output } = makeOutput();
    const result = runTriageCloseStale(
      triageCloseStaleOptionsSchema.parse({ limit: 1 }),
      output,
      deps,
    );
    expect(result.writes).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0]).toBe("ai-home-a");
  });

  test("bd-exec failure mid-batch: audit error row, other rows still processed, errors=1", () => {
    const rows = [
      stale({ beadsId: "ai-home-a", issueNumber: 100 }),
      stale({ beadsId: "ai-home-b", issueNumber: 200 }),
    ];
    const { deps, audit } = makeDeps({
      staleRows: rows,
      bdResults: [
        { exitCode: 1, stdout: "", stderr: "bd: lock contention", policy: null },
        { exitCode: 0, stdout: "", stderr: "", policy: null },
      ],
    });
    const { output, error } = makeOutput();
    const result = runTriageCloseStale(
      triageCloseStaleOptionsSchema.parse({}),
      output,
      deps,
    );
    expect(result.writes).toBe(1);
    expect(result.errors).toBe(1);
    const parsed = parseAudit(audit) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.action).toBe("error");
    expect(parsed[0]?.stderr).toBe("bd: lock contention");
    expect(parsed[1]?.action).toBe("update");
    expect(error.some((l) => l.includes("prx beads close exit=1"))).toBe(true);
  });

  test("canonical=bd repo: refuses with a clear message", () => {
    const { deps, calls } = makeDeps({ staleRows: [], canonical: "bd" });
    const { output, error } = makeOutput();
    const result = runTriageCloseStale(
      triageCloseStaleOptionsSchema.parse({}),
      output,
      deps,
    );
    expect(result.errors).toBe(1);
    expect(calls).toHaveLength(0);
    expect(error.some((l) => l.includes("bd-canonical repo"))).toBe(true);
  });

  test("emitted audit rows are accepted by auditRowSchema (union arm registered)", () => {
    const rows = [stale()];
    const { deps, audit } = makeDeps({ staleRows: rows });
    const { output } = makeOutput();
    runTriageCloseStale(
      triageCloseStaleOptionsSchema.parse({}),
      output,
      deps,
    );
    for (const line of audit) {
      const parsed = JSON.parse(line);
      expect(() => auditRowSchema.parse(parsed)).not.toThrow();
    }
  });

  // GH-1804: per-row + summary progress lines belong to plain mode only;
  // emitting them on `--format=json` interleaves with the trailing JSON blob
  // the CLI appends, breaking `prx triage close-stale --format=json | jq`.
  test("format=json: dry-run emits zero output.log calls (stdout stays parseable JSON)", () => {
    const rows = [
      stale({ beadsId: "ai-home-a", issueNumber: 100 }),
      stale({ beadsId: "ai-home-b", issueNumber: 200 }),
    ];
    const { deps } = makeDeps({ staleRows: rows });
    const { output, log, error } = makeOutput();
    const result = runTriageCloseStale(
      triageCloseStaleOptionsSchema.parse({ dryRun: true, format: "json" }),
      output,
      deps,
    );
    expect(result.writes).toBe(2);
    expect(result.errors).toBe(0);
    expect(log).toEqual([]);
    expect(error).toEqual([]);
  });

  test("format=json: write path emits zero output.log calls (per-row + summary suppressed)", () => {
    const rows = [
      stale({ beadsId: "ai-home-a", issueNumber: 100 }),
      stale({ beadsId: "ai-home-b", issueNumber: 200 }),
    ];
    const { deps } = makeDeps({ staleRows: rows });
    const { output, log, error } = makeOutput();
    const result = runTriageCloseStale(
      triageCloseStaleOptionsSchema.parse({ format: "json" }),
      output,
      deps,
    );
    expect(result.writes).toBe(2);
    expect(result.errors).toBe(0);
    expect(log).toEqual([]);
    expect(error).toEqual([]);
  });

  test("format=json: bd-exec error still uses output.error (stderr), not output.log", () => {
    const rows = [stale({ beadsId: "ai-home-a", issueNumber: 100 })];
    const { deps } = makeDeps({
      staleRows: rows,
      bdResults: [{ exitCode: 1, stdout: "", stderr: "bd: lock", policy: null }],
    });
    const { output, log, error } = makeOutput();
    const result = runTriageCloseStale(
      triageCloseStaleOptionsSchema.parse({ format: "json" }),
      output,
      deps,
    );
    expect(result.errors).toBe(1);
    expect(log).toEqual([]);
    expect(error.some((l) => l.includes("prx beads close exit=1"))).toBe(true);
  });

  test("format=plain (default): summary line still streams via output.log", () => {
    const { deps } = makeDeps({ staleRows: [] });
    const { output, log } = makeOutput();
    runTriageCloseStale(
      triageCloseStaleOptionsSchema.parse({ format: "plain" }),
      output,
      deps,
    );
    expect(log.some((l) => l.startsWith("triage close-stale: writes=0"))).toBe(true);
  });
});
