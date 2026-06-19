// GH-1397 — drain harness integration tests.
//
// Covers:
//   - Happy path: enqueue → drain via noop adapter → status done + audit
//     rows (HANDOFF_CLAIMED, HANDOFF_DRAINED) emitted.
//   - Failure path: adapter returns {ok:false} → status flips failed →
//     re-enqueued for retry; at max attempts → abandoned.
//   - Drain-time policy deny (I-HQ2): policyHint that says no → DRAIN_FAILED
//     fires without ever calling the adapter.
//   - Concurrency: two drainers race; only one wins the CLAIM.

import { beforeEach, describe, expect, test } from "bun:test";

import type { WorkUnitId } from "@bounded-systems/machine-schema";

import { clearRegistryForTests, drain, registerAdapter } from "../../src/handoff/drain.ts";
import { enqueueHandoff, type HandoffStoreDeps } from "../../src/handoff/store.ts";
import type { BdExecOptions, BdExecResult } from "@bounded-systems/bd";

type Capture = {
  remembers: Array<{ key: string; body: string }>;
  auditRows: unknown[];
};

function makeFakeBd(inMemoryRows: Map<string, string>, cap: Capture): HandoffStoreDeps["execBd"] {
  return (opts: BdExecOptions): BdExecResult => {
    if (opts.subcommand === "remember") {
      const body = opts.args[0] as string;
      const keyIdx = opts.args.indexOf("--key");
      const key = (keyIdx >= 0 ? opts.args[keyIdx + 1] : "") as string;
      cap.remembers.push({ key, body });
      inMemoryRows.set(key, body);
      return { exitCode: 0, stdout: "{}", stderr: "", policy: null };
    }
    if (opts.subcommand === "memories") {
      const prefix = opts.args[0] as string;
      const rows: Array<{ key: string; body: string }> = [];
      for (const [k, v] of inMemoryRows) {
        if (k.startsWith(prefix)) rows.push({ key: k, body: v });
      }
      return { exitCode: 0, stdout: JSON.stringify(rows), stderr: "", policy: null };
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: `unexpected subcommand: ${opts.subcommand}`,
      policy: null,
    };
  };
}

function baseEnqueueInput(verb = "test.verb") {
  return {
    workUnitId: "GH-1397" as WorkUnitId,
    repoSlug: "bdelanghe/ai-home",
    sourceActor: "executor",
    targetActor: "noop" as const,
    intent: { verb, args: { a: 1 } },
    denialReason: "not-allowlisted-for-role" as const,
  };
}

function appendAuditRowFake(cap: Capture) {
  return ((row: unknown) => {
    cap.auditRows.push(row);
  }) as unknown as typeof import("../../src/audit/sink.ts").appendAuditRow;
}

beforeEach(() => {
  clearRegistryForTests();
});

describe("drain — happy path", () => {
  test("noop adapter drains a pending row → status done; audit rows emitted", async () => {
    const inMemory = new Map<string, string>();
    const cap: Capture = { remembers: [], auditRows: [] };
    const exec = makeFakeBd(inMemory, cap);

    const created = await enqueueHandoff(baseEnqueueInput(), { execBd: exec });
    if (created.kind !== "created") throw new Error("expected created");

    const result = await drain(
      { target: "noop" },
      { execBd: exec, appendAuditRow: appendAuditRowFake(cap) },
    );
    expect(result.drained).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.outcomes[0]?.outcome).toBe("done");

    // The persisted envelope is now `done`.
    const lastWrite = cap.remembers.at(-1);
    expect(lastWrite).toBeDefined();
    const persisted = JSON.parse(lastWrite!.body) as { status: string };
    expect(persisted.status).toBe("done");

    // HANDOFF_CLAIMED + HANDOFF_DRAINED both fired.
    const events = cap.auditRows.map((r) => (r as { event?: string }).event).filter(Boolean);
    expect(events).toContain("HANDOFF_CLAIMED");
    expect(events).toContain("HANDOFF_DRAINED");
  });

  test("every audit row carries uow_id + handoff_id (I-HQ1)", async () => {
    const inMemory = new Map<string, string>();
    const cap: Capture = { remembers: [], auditRows: [] };
    const exec = makeFakeBd(inMemory, cap);
    const created = await enqueueHandoff(baseEnqueueInput(), { execBd: exec });
    if (created.kind !== "created") throw new Error("expected created");

    await drain({ target: "noop" }, { execBd: exec, appendAuditRow: appendAuditRowFake(cap) });

    const handoffEvents = cap.auditRows.filter(
      (r) => (r as { kind?: string }).kind === "catalog-event",
    );
    expect(handoffEvents.length).toBeGreaterThan(0);
    for (const row of handoffEvents) {
      const r = row as {
        workUnitId?: string;
        details?: { handoff_id?: string };
      };
      expect(r.workUnitId).toBe("GH-1397");
      expect(r.details?.handoff_id).toBe(created.envelope.id);
    }
  });
});

describe("drain — failure paths", () => {
  test("adapter {ok:false} → row re-enqueued for retry (attempts++)", async () => {
    const inMemory = new Map<string, string>();
    const cap: Capture = { remembers: [], auditRows: [] };
    const exec = makeFakeBd(inMemory, cap);
    registerAdapter("noop", {
      apply: async () => ({ ok: false, error: "transient failure" }),
    });

    const created = await enqueueHandoff(baseEnqueueInput(), { execBd: exec });
    if (created.kind !== "created") throw new Error("expected created");

    const r = await drain(
      { target: "noop" },
      { execBd: exec, appendAuditRow: appendAuditRowFake(cap) },
    );
    expect(r.failed).toBe(1);
    expect(r.outcomes[0]?.outcome).toBe("failed");

    const persisted = JSON.parse(cap.remembers.at(-1)!.body) as {
      status: string;
      attempts: number;
      lastError?: string;
    };
    expect(persisted.status).toBe("pending");
    expect(persisted.attempts).toBe(1);
  });

  test("retries exhausted → row marked abandoned", async () => {
    const inMemory = new Map<string, string>();
    const cap: Capture = { remembers: [], auditRows: [] };
    const exec = makeFakeBd(inMemory, cap);
    registerAdapter("noop", {
      apply: async () => ({ ok: false, error: "permanent failure" }),
    });

    const created = await enqueueHandoff(baseEnqueueInput(), { execBd: exec });
    if (created.kind !== "created") throw new Error("expected created");

    // Drain three times — max attempts is 3 (default).
    await drain({ target: "noop" }, { execBd: exec, appendAuditRow: appendAuditRowFake(cap) });
    await drain({ target: "noop" }, { execBd: exec, appendAuditRow: appendAuditRowFake(cap) });
    await drain({ target: "noop" }, { execBd: exec, appendAuditRow: appendAuditRowFake(cap) });

    const persisted = JSON.parse(cap.remembers.at(-1)!.body) as {
      status: string;
      attempts: number;
    };
    expect(persisted.status).toBe("abandoned");
    const events = cap.auditRows.map((r) => (r as { event?: string }).event).filter(Boolean);
    expect(events).toContain("HANDOFF_ABANDONED");
  });

  test("drain-time policy deny short-circuits the adapter (I-HQ2)", async () => {
    const inMemory = new Map<string, string>();
    const cap: Capture = { remembers: [], auditRows: [] };
    const exec = makeFakeBd(inMemory, cap);
    let adapterCalls = 0;
    registerAdapter("noop", {
      // Adapter requests drain-time gate against a state the recipient role
      // is not allowed in.
      policyHint: () => ({
        tool: "git",
        subcommand: "reset", // hard-blocked
        state: "validating",
        role: "executor",
      }),
      apply: async () => {
        adapterCalls += 1;
        return { ok: true };
      },
    });
    const created = await enqueueHandoff(baseEnqueueInput(), { execBd: exec });
    if (created.kind !== "created") throw new Error("expected created");

    const r = await drain(
      { target: "noop" },
      { execBd: exec, appendAuditRow: appendAuditRowFake(cap) },
    );

    expect(adapterCalls).toBe(0);
    expect(r.failed).toBe(1);
    expect(r.outcomes[0]?.outcome).toBe("failed");
    expect(r.outcomes[0]?.error).toContain("drain-time policy deny");
  });
});

describe("drain — concurrency", () => {
  test("two drainers race on one row; only one wins the CLAIM", async () => {
    const inMemory = new Map<string, string>();
    const cap: Capture = { remembers: [], auditRows: [] };
    const exec = makeFakeBd(inMemory, cap);

    const created = await enqueueHandoff(baseEnqueueInput(), { execBd: exec });
    if (created.kind !== "created") throw new Error("expected created");

    const [a, b] = await Promise.all([
      drain(
        { target: "noop", claimant: "drainer-A" },
        { execBd: exec, appendAuditRow: appendAuditRowFake(cap) },
      ),
      drain(
        { target: "noop", claimant: "drainer-B" },
        { execBd: exec, appendAuditRow: appendAuditRowFake(cap) },
      ),
    ]);
    // One drainer sees the row, the other gets nothing (or is skipped).
    const totalDrained = a.drained + b.drained;
    expect(totalDrained).toBe(1);
  });
});
