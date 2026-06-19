// GH-1057 — `prx plan close` (close-without-merge wrapper).
// GH-2110 — bd-record close-and-verify wired into `planClose`.
//
// Coverage: argv ordering through `gh issue comment` + `gh issue close` +
// reconcile; dry-run short-circuit; idempotency on already-closed issue;
// default reason; bd-record close/skip/error/multi shapes; CLI surface
// end-to-end via `runCliDirect`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteEnv, getEnv, setEnv } from "@bounded-systems/env";
import { ZodError } from "zod";
import { getUnit, putUnit } from "../../src/pr-state/projection.ts";
import {
  planClose,
  planCloseReasonToGhReason,
  type PlanCloseOptions,
  planCloseReasonToBdReason,
  type PlanCloseBdRecordOutcome,
  type PlanCloseResult,
} from "../../src/pr-state/plan-close-bd.ts";
import { parseArgs } from "@bounded-systems/verbspec";
import { planCloseVerb, type PlanCloseVerbDeps } from "../../src/pr-state/plan-close-verb.ts";

// `prx plan close` is a VerbSpec now; this drives the CLI path (parse → run →
// render → exit) with injected deps, the way the legacy `runCliDirect(..., {
// planClose })` harness used to. argv arrives as ["plan","close", ...rest].
async function runCliDirect(
  argv: string[],
  output: { log: (l: string) => void; error: (l: string) => void },
  deps: PlanCloseVerbDeps,
): Promise<number> {
  const rest = argv.slice(2);
  try {
    const input = parseArgs(planCloseVerb as never, rest) as Parameters<
      typeof planCloseVerb.run
    >[0];
    const out = await planCloseVerb.run(input, deps);
    output.log(planCloseVerb.render!(out, input));
    return planCloseVerb.exitCode!(out, input);
  } catch (e) {
    if (e instanceof ZodError) {
      output.error(e.issues[0]?.message ?? e.message);
      return 1;
    }
    output.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
import type { CommandRunner as GithubCommandRunner } from "../../src/pr-state/github.ts";
import type { BdShowResult } from "@bounded-systems/bd";
import type { BdIssueCloseResult } from "../../src/tools/bd_issue_close.ts";
import type { BeadsRecord } from "../../src/triage/triage.ts";

type RunnerCall = { cmd: string[]; check: boolean };

function recordingRunner(
  responses: Array<{
    match: (cmd: string[]) => boolean;
    stdout?: string;
    stderr?: string;
    status: number;
  }>,
): { runner: GithubCommandRunner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];
  const runner: GithubCommandRunner = (cmd, options = {}) => {
    calls.push({ cmd: [...cmd], check: options.check !== false });
    for (const r of responses) {
      if (r.match(cmd)) {
        return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
      }
    }
    throw new Error(`unexpected runner call: ${cmd.join(" ")}`);
  };
  return { runner, calls };
}

function defaultOptions(overrides: Partial<PlanCloseOptions> = {}): PlanCloseOptions {
  return {
    workUnitId: "GH-1050",
    reason: "completed",
    upstream: null,
    dryRun: false,
    emitNext: true,
    ...overrides,
  };
}

// GH-2011: `runBeadsSync` stub used in place of the retired `bdSync` seam.
function makeBeadsSyncStub(exitCode = 0) {
  let calls = 0;
  const stub = async () => {
    calls += 1;
    return {
      exitCode,
      summary: {
        repo: "",
        domain: "gh",
        scanned: 0,
        pinned: 0,
        skipped: 0,
        pulled: 0,
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
  };
  return Object.assign(stub as any, { calls: () => calls });
}

// GH-2110: stub the bd-record close-and-verify deps. Returning an empty bead
// set short-circuits the helper to `skip:no-bead-link` — the right default
// for the gh-chain tests below that don't exercise the bd path.
const noBeadsLoader = (): BeadsRecord[] => [];

function makeBead(overrides: Partial<BeadsRecord>): BeadsRecord {
  return {
    id: overrides.id ?? "BD-deadbeef",
    title: "",
    description: null,
    status: overrides.status ?? "in_progress",
    priority: null,
    issueType: null,
    labels: [],
    blockedBy: [],
    externalRef: overrides.externalRef ?? null,
    externalRefs: overrides.externalRefs ?? {},
    metadata: null,
    externalIssueNumber: overrides.externalIssueNumber ?? null,
    sourceSystem: null,
    ...overrides,
  } as BeadsRecord;
}

function showOk(status: string): BdShowResult {
  return {
    ok: true,
    record: { id: "x", title: "", status, externalRefs: {} } as any,
    stdout: "",
    stderr: "",
  };
}

function closeOk(): BdIssueCloseResult {
  return { exitCode: 0, stdout: "", stderr: "" };
}

function closeErr(stderr: string): BdIssueCloseResult {
  return { exitCode: 1, stdout: "", stderr };
}

describe("planClose() — comment + close + bd sync", () => {
  test("posts comment, closes, syncs in order; emits handoff", async () => {
    const { runner, calls } = recordingRunner([
      // gh repo view (repoNameWithOwner)
      {
        match: (c) => c[0] === "gh" && c[1] === "repo" && c[2] === "view",
        stdout: "bdelanghe/ai-home\n",
        status: 0,
      },
      // gh issue view (maybeViewIssue → state OPEN)
      {
        match: (c) => c[0] === "gh" && c[1] === "issue" && c[2] === "view" && c.includes("--json"),
        stdout: JSON.stringify({ number: 1050, state: "OPEN" }),
        status: 0,
      },
      // gh issue comment
      {
        match: (c) => c[0] === "gh" && c[1] === "issue" && c[2] === "comment",
        status: 0,
      },
      // gh issue close
      {
        match: (c) => c[0] === "gh" && c[1] === "issue" && c[2] === "close",
        status: 0,
      },
    ]);

    const result = await planClose(
      defaultOptions({ upstream: "https://github.com/example/repo/issues/99" }),
      {
        cwd: "/tmp/wt",
        runner,
        beadsSync: makeBeadsSyncStub(0),
        loadAllBeads: noBeadsLoader,
      },
    );

    expect(result.refusalReason).toBeNull();
    expect(result.upstreamCommentPosted).toBe(true);
    expect(result.issueClosed).toBe(true);
    expect(result.bdSyncExitCode).toBe(0);
    expect(result.handoff).toEqual([
      "prx worktree-remove GH-1050 --delete-branch --force",
      "prx delegate next",
    ]);

    const ghCalls = calls.filter((c) => c.cmd[0] === "gh");
    const ghOps = ghCalls.map((c) => c.cmd.slice(1, 3).join(" "));
    expect(ghOps).toEqual(["repo view", "issue view", "issue comment", "issue close"]);
    const closeCmd = ghCalls.find((c) => c.cmd[2] === "close")!.cmd;
    expect(closeCmd).toContain("--reason");
    expect(closeCmd[closeCmd.indexOf("--reason") + 1]).toBe("completed");
  });

  test("--upstream omitted → no comment call", async () => {
    const { runner, calls } = recordingRunner([
      {
        match: (c) => c[0] === "gh" && c[1] === "repo" && c[2] === "view",
        stdout: "bdelanghe/ai-home\n",
        status: 0,
      },
      {
        match: (c) => c[0] === "gh" && c[1] === "issue" && c[2] === "view",
        stdout: JSON.stringify({ number: 1050, state: "OPEN" }),
        status: 0,
      },
      {
        match: (c) => c[0] === "gh" && c[1] === "issue" && c[2] === "close",
        status: 0,
      },
    ]);

    const result = await planClose(defaultOptions(), {
      cwd: "/tmp/wt",
      runner,
      beadsSync: makeBeadsSyncStub(0),
      loadAllBeads: noBeadsLoader,
    });

    expect(result.upstreamCommentPosted).toBe(false);
    expect(result.issueClosed).toBe(true);
    expect(calls.find((c) => c.cmd[2] === "comment")).toBeUndefined();
  });

  // GH-1720: pin the argv shape passed to `gh issue close --reason`. The
  // canonical prx surface uses the hyphen form (`not-planned`), but the gh CLI
  // only accepts the space form (`not planned`); without this assertion, the
  // upstream-shape mismatch shipped because we only checked `result.reason`.
  const reasonArgvCases: Array<{
    reason: PlanCloseOptions["reason"];
    ghArg: string;
  }> = [
    { reason: "completed", ghArg: "completed" },
    { reason: "not-planned", ghArg: "not planned" },
    { reason: "duplicate", ghArg: "duplicate" },
  ];

  for (const { reason, ghArg } of reasonArgvCases) {
    test(`--reason ${reason} passes "${ghArg}" to gh issue close`, async () => {
      const { runner, calls } = recordingRunner([
        {
          match: (c) => c[0] === "gh" && c[1] === "repo" && c[2] === "view",
          stdout: "bdelanghe/ai-home\n",
          status: 0,
        },
        {
          match: (c) => c[0] === "gh" && c[1] === "issue" && c[2] === "view",
          stdout: JSON.stringify({ number: 1050, state: "OPEN" }),
          status: 0,
        },
        {
          match: (c) => c[0] === "gh" && c[1] === "issue" && c[2] === "close",
          status: 0,
        },
      ]);

      const result = await planClose(defaultOptions({ reason }), {
        cwd: "/tmp/wt",
        runner,
        beadsSync: makeBeadsSyncStub(0),
        loadAllBeads: noBeadsLoader,
      });

      expect(result.reason).toBe(reason);
      const closeCmd = calls.find((c) => c.cmd[2] === "close")!.cmd;
      expect(closeCmd).toContain("--reason");
      expect(closeCmd[closeCmd.indexOf("--reason") + 1]).toBe(ghArg);
    });
  }

  test("planCloseReasonToGhReason translates hyphen → space at the seam", () => {
    expect(planCloseReasonToGhReason("completed")).toBe("completed");
    expect(planCloseReasonToGhReason("not-planned")).toBe("not planned");
    expect(planCloseReasonToGhReason("duplicate")).toBe("duplicate");
  });

  test("already-closed issue → refusal, no close call", async () => {
    const { runner, calls } = recordingRunner([
      {
        match: (c) => c[0] === "gh" && c[1] === "repo" && c[2] === "view",
        stdout: "bdelanghe/ai-home\n",
        status: 0,
      },
      {
        match: (c) => c[0] === "gh" && c[1] === "issue" && c[2] === "view",
        stdout: JSON.stringify({ number: 1050, state: "CLOSED" }),
        status: 0,
      },
    ]);

    const result = await planClose(defaultOptions(), {
      cwd: "/tmp/wt",
      runner,
      beadsSync: makeBeadsSyncStub(0),
      loadAllBeads: noBeadsLoader,
    });

    expect(result.refusalReason).toContain("already closed");
    expect(result.issueClosed).toBe(false);
    expect(calls.find((c) => c.cmd[2] === "close")).toBeUndefined();
  });

  test("--dry-run → no mutating calls, handoff still emitted", async () => {
    const { runner, calls } = recordingRunner([
      {
        match: (c) => c[0] === "gh" && c[1] === "repo" && c[2] === "view",
        stdout: "bdelanghe/ai-home\n",
        status: 0,
      },
      {
        match: (c) => c[0] === "gh" && c[1] === "issue" && c[2] === "view",
        stdout: JSON.stringify({ number: 1050, state: "OPEN" }),
        status: 0,
      },
    ]);

    const beadsSync = makeBeadsSyncStub(0);
    const result = await planClose(
      defaultOptions({ upstream: "https://example.com/u", dryRun: true }),
      {
        cwd: "/tmp/wt",
        runner,
        beadsSync,
        loadAllBeads: noBeadsLoader,
      },
    );

    expect(result.dryRun).toBe(true);
    expect(result.issueClosed).toBe(false);
    expect(result.upstreamCommentPosted).toBe(false);
    expect(result.bdSyncExitCode).toBeNull();
    // GH-2011: dry-run skips the canonical reconcile entirely.
    expect(beadsSync.calls()).toBe(0);
    expect(result.handoff).toContain("prx worktree-remove GH-1050 --delete-branch --force");
    expect(calls.find((c) => c.cmd[2] === "close")).toBeUndefined();
    expect(calls.find((c) => c.cmd[2] === "comment")).toBeUndefined();
  });

  test("bd sync non-zero exit is reported, not refused", async () => {
    const { runner } = recordingRunner([
      {
        match: (c) => c[0] === "gh" && c[1] === "repo" && c[2] === "view",
        stdout: "bdelanghe/ai-home\n",
        status: 0,
      },
      {
        match: (c) => c[0] === "gh" && c[1] === "issue" && c[2] === "view",
        stdout: JSON.stringify({ number: 1050, state: "OPEN" }),
        status: 0,
      },
      {
        match: (c) => c[0] === "gh" && c[1] === "issue" && c[2] === "close",
        status: 0,
      },
    ]);

    const result = await planClose(defaultOptions(), {
      cwd: "/tmp/wt",
      runner,
      beadsSync: makeBeadsSyncStub(1),
      loadAllBeads: noBeadsLoader,
    });

    expect(result.issueClosed).toBe(true);
    expect(result.bdSyncExitCode).toBe(1);
    expect(result.bdRecord?.outcome).toBe("skip:no-bead-link");
    expect(result.refusalReason).toBeNull();
  });

  test("comment post failure → refusal, no close call", async () => {
    const { runner, calls } = recordingRunner([
      {
        match: (c) => c[0] === "gh" && c[1] === "repo" && c[2] === "view",
        stdout: "bdelanghe/ai-home\n",
        status: 0,
      },
      {
        match: (c) => c[0] === "gh" && c[1] === "issue" && c[2] === "view",
        stdout: JSON.stringify({ number: 1050, state: "OPEN" }),
        status: 0,
      },
      {
        match: (c) => c[0] === "gh" && c[1] === "issue" && c[2] === "comment",
        stderr: "permission denied",
        status: 1,
      },
    ]);

    const result = await planClose(defaultOptions({ upstream: "https://example.com/u" }), {
      cwd: "/tmp/wt",
      runner,
      beadsSync: makeBeadsSyncStub(0),
      loadAllBeads: noBeadsLoader,
    });

    expect(result.refusalReason).toContain("permission denied");
    expect(result.issueClosed).toBe(false);
    expect(calls.find((c) => c.cmd[2] === "close")).toBeUndefined();
  });
});

describe("`prx plan close` CLI surface", () => {
  function stubResult(overrides: Partial<PlanCloseResult> = {}): PlanCloseResult {
    return {
      workUnitId: "GH-1050",
      issueNumber: 1050,
      reason: "completed",
      upstream: null,
      upstreamCommentPosted: false,
      issueClosed: true,
      bdRecord: { outcome: "closed", ok: true, perId: [{ id: "BD-x", kind: "closed" }] },
      bdSyncExitCode: 0,
      handoff: ["prx worktree-remove GH-1050 --delete-branch --force", "prx delegate next"],
      refusalReason: null,
      dryRun: false,
      ...overrides,
    };
  }

  test("dispatcher rewrites `plan close GH-1050` → plan-close handler", async () => {
    const logs: string[] = [];
    let received: PlanCloseOptions | undefined;
    const exitCode = await runCliDirect(
      ["plan", "close", "GH-1050"],
      { log: (l) => logs.push(l), error: () => {} },
      {
        planClose: (options) => {
          received = options;
          return Promise.resolve(stubResult());
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(received).toEqual({
      workUnitId: "GH-1050",
      reason: "completed",
      upstream: null,
      dryRun: false,
      emitNext: true,
    });
    const out = logs.join("\n");
    expect(out).toContain("plan-close=GH-1050");
    expect(out).toContain("issue=closed");
    expect(out).toContain("bd_record=closed");
    expect(out).toContain("reconcile=ok");
    expect(out).not.toContain("bd_sync=");
    expect(out).toContain("prx worktree-remove GH-1050 --delete-branch --force");
  });

  test("--reason and --upstream propagate", async () => {
    let received: PlanCloseOptions | undefined;
    await runCliDirect(
      [
        "plan",
        "close",
        "GH-1050",
        "--reason",
        "not-planned",
        "--upstream",
        "https://github.com/upstream/repo/issues/99",
      ],
      { log: () => {}, error: () => {} },
      {
        planClose: (options) => {
          received = options;
          return Promise.resolve(
            stubResult({
              reason: "not-planned",
              upstream: "https://github.com/upstream/repo/issues/99",
              upstreamCommentPosted: true,
            }),
          );
        },
      },
    );

    expect(received?.reason).toBe("not-planned");
    expect(received?.upstream).toBe("https://github.com/upstream/repo/issues/99");
  });

  test("missing positional unit is rejected (no branch inference)", async () => {
    let called = false;
    const errors: string[] = [];
    const exitCode = await runCliDirect(
      ["plan", "close"],
      { log: () => {}, error: (l) => errors.push(l) },
      {
        planClose: () => {
          called = true;
          return Promise.resolve(stubResult());
        },
      },
    );

    expect(called).toBe(false);
    expect(exitCode).not.toBe(0);
    expect(errors.join("\n")).toMatch(/explicit work-unit id/);
  });

  test("invalid --reason rejected before handler runs", async () => {
    let called = false;
    const errors: string[] = [];
    const exitCode = await runCliDirect(
      ["plan", "close", "GH-1050", "--reason", "fixed"],
      { log: () => {}, error: (l) => errors.push(l) },
      {
        planClose: () => {
          called = true;
          return Promise.resolve(stubResult());
        },
      },
    );

    expect(called).toBe(false);
    expect(exitCode).not.toBe(0);
    expect(errors.join("\n")).toMatch(/--reason/);
  });

  test("refusal exits 1 and prints refusal line", async () => {
    const logs: string[] = [];
    const exitCode = await runCliDirect(
      ["plan", "close", "GH-1050"],
      { log: (l) => logs.push(l), error: () => {} },
      {
        planClose: () =>
          Promise.resolve(
            stubResult({
              issueClosed: false,
              bdSyncExitCode: null,
              refusalReason: "issue #1050 is already closed",
            }),
          ),
      },
    );

    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("refusal=issue #1050 is already closed");
  });

  test("--dry-run forwards to handler", async () => {
    let received: PlanCloseOptions | undefined;
    const exitCode = await runCliDirect(
      ["plan", "close", "GH-1050", "--dry-run"],
      { log: () => {}, error: () => {} },
      {
        planClose: (options) => {
          received = options;
          return Promise.resolve(
            stubResult({
              issueClosed: false,
              bdSyncExitCode: null,
              dryRun: true,
            }),
          );
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(received?.dryRun).toBe(true);
  });

  test("--no-next shrinks handoff (emitNext=false)", async () => {
    let received: PlanCloseOptions | undefined;
    await runCliDirect(
      ["plan", "close", "GH-1050", "--no-next"],
      { log: () => {}, error: () => {} },
      {
        planClose: (options) => {
          received = options;
          return Promise.resolve(stubResult());
        },
      },
    );

    expect(received?.emitNext).toBe(false);
  });

  test("--format json emits structured result", async () => {
    const logs: string[] = [];
    const exitCode = await runCliDirect(
      ["plan", "close", "GH-1050", "--format", "json"],
      { log: (l) => logs.push(l), error: () => {} },
      { planClose: () => Promise.resolve(stubResult()) },
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(logs[0]!);
    expect(parsed).toMatchObject({
      workUnitId: "GH-1050",
      reason: "completed",
      issueClosed: true,
      bdSyncExitCode: 0,
    });
  });
});

// GH-2110: bd-record close-and-verify. The reconcile tick can return 0 while
// leaving the linked bd record open (unpinned pair, --limit budget, GH
// eventual-consistency lag). `prx plan close` is the canonical close *actor*
// for this work unit, so it now performs an end-of-line close-and-verify and
// reports a truthful `bd_record` line independent of the reconcile outcome.
describe("planClose() — bd-record close-and-verify (GH-2110)", () => {
  // Reusable runner stub for the gh chain — the bd path is the focus here.
  function makeGhRunner(): GithubCommandRunner {
    const responses = [
      {
        match: (c: string[]) => c[0] === "gh" && c[1] === "repo" && c[2] === "view",
        stdout: "bdelanghe/ai-home\n",
        status: 0,
      },
      {
        match: (c: string[]) => c[0] === "gh" && c[1] === "issue" && c[2] === "view",
        stdout: JSON.stringify({ number: 1050, state: "OPEN" }),
        status: 0,
      },
      {
        match: (c: string[]) => c[0] === "gh" && c[1] === "issue" && c[2] === "close",
        status: 0,
      },
    ];
    return (cmd, options = {}) => {
      for (const r of responses) {
        if (r.match(cmd as string[])) {
          return { stdout: r.stdout ?? "", stderr: "", status: r.status };
        }
      }
      throw new Error(`unexpected runner call: ${(cmd as string[]).join(" ")}`);
    };
  }

  test("single linked bead → bd_record=closed; bd close called once with plan-completed reason", async () => {
    const bead = makeBead({ id: "BD-aaaa", externalIssueNumber: 1050, status: "in_progress" });
    const closeCalls: Array<{ id: string; reason?: string | undefined; cwd?: string | undefined }> =
      [];
    const showSeq: BdShowResult[] = [showOk("in_progress"), showOk("closed")];

    const result = await planClose(defaultOptions(), {
      cwd: "/tmp/wt",
      runner: makeGhRunner(),
      beadsSync: makeBeadsSyncStub(0),
      loadAllBeads: () => [bead],
      bdShow: () => showSeq.shift() ?? showOk("closed"),
      execBdIssueClose: (opts) => {
        closeCalls.push({ id: opts.id, reason: opts.reason, cwd: opts.cwd });
        return closeOk();
      },
    });

    expect(result.bdRecord?.outcome).toBe("closed");
    expect(result.bdRecord?.ok).toBe(true);
    expect(closeCalls).toEqual([
      { id: "BD-aaaa", reason: planCloseReasonToBdReason("completed"), cwd: "/tmp/wt" },
    ]);
  });

  test("single linked bead already closed → bd_record=skip:already-closed; bd close NOT called", async () => {
    const bead = makeBead({ id: "BD-already", externalIssueNumber: 1050, status: "closed" });
    let closeInvoked = false;

    const result = await planClose(defaultOptions(), {
      cwd: "/tmp/wt",
      runner: makeGhRunner(),
      beadsSync: makeBeadsSyncStub(0),
      loadAllBeads: () => [bead],
      bdShow: () => showOk("closed"),
      execBdIssueClose: () => {
        closeInvoked = true;
        return closeOk();
      },
    });

    expect(result.bdRecord?.outcome).toBe("skip:already-closed");
    expect(result.bdRecord?.ok).toBe(true);
    expect(closeInvoked).toBe(false);
  });

  test("no bead linked → bd_record=skip:no-bead-link", async () => {
    const result = await planClose(defaultOptions(), {
      cwd: "/tmp/wt",
      runner: makeGhRunner(),
      beadsSync: makeBeadsSyncStub(0),
      loadAllBeads: noBeadsLoader,
      bdShow: () => {
        throw new Error("bdShow should not be called when no bead is linked");
      },
      execBdIssueClose: () => {
        throw new Error("execBdIssueClose should not be called when no bead is linked");
      },
    });

    expect(result.bdRecord?.outcome).toBe("skip:no-bead-link");
    expect(result.bdRecord?.ok).toBe(true);
  });

  test("bd close non-zero → bd_record carries error detail; verb exits non-zero via CLI", async () => {
    const bead = makeBead({ id: "BD-fail", externalIssueNumber: 1050, status: "in_progress" });

    const result = await planClose(defaultOptions(), {
      cwd: "/tmp/wt",
      runner: makeGhRunner(),
      beadsSync: makeBeadsSyncStub(0),
      loadAllBeads: () => [bead],
      bdShow: () => showOk("in_progress"),
      execBdIssueClose: () => closeErr("bd: write conflict"),
    });

    expect(result.bdRecord?.outcome.startsWith("error:bd-close:")).toBe(true);
    expect(result.bdRecord?.outcome).toContain("write conflict");
    expect(result.bdRecord?.ok).toBe(false);
    expect(result.issueClosed).toBe(true);

    // GH-2110: the CLI must surface this as a non-zero verb exit even though
    // GH close succeeded — shell hooks downstream must see the failure.
    const exitCode = await runCliDirect(
      ["plan", "close", "GH-1050"],
      { log: () => {}, error: () => {} },
      { planClose: () => Promise.resolve(result) },
    );
    expect(exitCode).toBe(1);
  });

  test("post-close bd show still reports in_progress → bd_record=error:state-not-closed:in_progress (the GH-2110 symptom)", async () => {
    const bead = makeBead({ id: "BD-stuck", externalIssueNumber: 1050, status: "in_progress" });

    const result = await planClose(defaultOptions(), {
      cwd: "/tmp/wt",
      runner: makeGhRunner(),
      beadsSync: makeBeadsSyncStub(0),
      loadAllBeads: () => [bead],
      // Both pre-close and post-close `bd show` say IN_PROGRESS — bd close
      // returned 0 but the transition didn't land.
      bdShow: () => showOk("in_progress"),
      execBdIssueClose: () => closeOk(),
    });

    expect(result.bdRecord?.outcome).toBe("error:state-not-closed:in_progress");
    expect(result.bdRecord?.ok).toBe(false);

    const exitCode = await runCliDirect(
      ["plan", "close", "GH-1050"],
      { log: () => {}, error: () => {} },
      { planClose: () => Promise.resolve(result) },
    );
    expect(exitCode).toBe(1);
  });

  test("multi-bead link all closed → bd_record=multi:2/2; verb exit 0", async () => {
    const beads = [
      makeBead({ id: "BD-1", externalIssueNumber: 1050, status: "in_progress" }),
      makeBead({ id: "BD-2", externalIssueNumber: 1050, status: "in_progress" }),
    ];
    // Per-bead: pre-show (open), post-show (closed). 4 calls total in order.
    const showSeq: BdShowResult[] = [
      showOk("in_progress"),
      showOk("closed"),
      showOk("in_progress"),
      showOk("closed"),
    ];

    const result = await planClose(defaultOptions(), {
      cwd: "/tmp/wt",
      runner: makeGhRunner(),
      beadsSync: makeBeadsSyncStub(0),
      loadAllBeads: () => beads,
      bdShow: () => showSeq.shift() ?? showOk("closed"),
      execBdIssueClose: () => closeOk(),
    });

    expect(result.bdRecord?.outcome).toBe("multi:2/2");
    expect(result.bdRecord?.ok).toBe(true);
    expect(result.bdRecord?.perId.length).toBe(2);
    expect(result.bdRecord?.perId.every((p) => p.kind === "closed")).toBe(true);
  });

  test("multi-bead partial failure → bd_record=multi:1/2; verb exits non-zero via CLI", async () => {
    const beads = [
      makeBead({ id: "BD-good", externalIssueNumber: 1050, status: "in_progress" }),
      makeBead({ id: "BD-bad", externalIssueNumber: 1050, status: "in_progress" }),
    ];
    // First bead pre-show open → close ok → post-show closed.
    // Second bead pre-show open, then close errors (no post-show on that path).
    const showSeq: BdShowResult[] = [
      showOk("in_progress"),
      showOk("closed"),
      showOk("in_progress"),
    ];

    const result = await planClose(defaultOptions(), {
      cwd: "/tmp/wt",
      runner: makeGhRunner(),
      beadsSync: makeBeadsSyncStub(0),
      loadAllBeads: () => beads,
      bdShow: () => showSeq.shift() ?? showOk("in_progress"),
      execBdIssueClose: (opts) =>
        opts.id === "BD-bad" ? closeErr("permission denied") : closeOk(),
    });

    expect(result.bdRecord?.outcome).toBe("multi:1/2");
    expect(result.bdRecord?.ok).toBe(false);

    const exitCode = await runCliDirect(
      ["plan", "close", "GH-1050"],
      { log: () => {}, error: () => {} },
      { planClose: () => Promise.resolve(result) },
    );
    expect(exitCode).toBe(1);
  });

  test("reconcile non-zero with bd_record=closed → verb exits 0; reconcile=exit-N line printed alongside bd_record=closed", async () => {
    const bead = makeBead({ id: "BD-ok", externalIssueNumber: 1050, status: "in_progress" });
    const showSeq: BdShowResult[] = [showOk("in_progress"), showOk("closed")];

    const result = await planClose(defaultOptions(), {
      cwd: "/tmp/wt",
      runner: makeGhRunner(),
      beadsSync: makeBeadsSyncStub(2),
      loadAllBeads: () => [bead],
      bdShow: () => showSeq.shift() ?? showOk("closed"),
      execBdIssueClose: () => closeOk(),
    });

    expect(result.bdRecord?.outcome).toBe("closed");
    expect(result.bdSyncExitCode).toBe(2);

    const logs: string[] = [];
    const exitCode = await runCliDirect(
      ["plan", "close", "GH-1050"],
      { log: (l) => logs.push(l), error: () => {} },
      { planClose: () => Promise.resolve(result) },
    );
    expect(exitCode).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("bd_record=closed");
    expect(out).toContain("reconcile=exit-2");
  });

  test("plain output shape (snapshot) — bd_record and reconcile both present, in order", async () => {
    const bead = makeBead({ id: "BD-snap", externalIssueNumber: 1050, status: "in_progress" });
    const showSeq: BdShowResult[] = [showOk("in_progress"), showOk("closed")];

    const result = await planClose(defaultOptions({ emitNext: false }), {
      cwd: "/tmp/wt",
      runner: makeGhRunner(),
      beadsSync: makeBeadsSyncStub(0),
      loadAllBeads: () => [bead],
      bdShow: () => showSeq.shift() ?? showOk("closed"),
      execBdIssueClose: () => closeOk(),
    });

    const logs: string[] = [];
    await runCliDirect(
      ["plan", "close", "GH-1050", "--no-next"],
      { log: (l) => logs.push(l), error: () => {} },
      { planClose: () => Promise.resolve(result) },
    );

    expect(logs.join("\n")).toBe(
      [
        "plan-close=GH-1050",
        "reason=completed",
        "upstream=none",
        "dry_run=false",
        "upstream_comment=skipped",
        "issue=closed",
        "bd_record=closed",
        "reconcile=ok",
        "handoff:",
        "  prx worktree-remove GH-1050 --delete-branch --force",
      ].join("\n"),
    );
  });
});

describe("planCloseReasonToBdReason — provenance", () => {
  test("translates plan-close reasons to bd close_reason slot", () => {
    expect(planCloseReasonToBdReason("completed")).toBe("closed-by-plan-completed");
    expect(planCloseReasonToBdReason("not-planned")).toBe("closed-by-plan-not-planned");
    expect(planCloseReasonToBdReason("duplicate")).toBe("closed-by-plan-duplicate");
  });

  test("distinct from postmerge `closed-by-pull` so provenance is recoverable", () => {
    const bdReasons: PlanCloseBdRecordOutcome = {
      outcome: "closed",
      ok: true,
      perId: [{ id: "BD-x", kind: "closed" }],
    };
    expect(bdReasons.outcome).toBe("closed");
    expect(planCloseReasonToBdReason("completed")).not.toBe("closed-by-pull");
  });
});

describe("planClose() — self-mutation projection invalidation (GH-2074 PR-3)", () => {
  let savedCacheHome: string | undefined;
  let savedWtDisable: string | undefined;
  let savedProjDisable: string | undefined;

  beforeEach(() => {
    savedCacheHome = getEnv("XDG_CACHE_HOME");
    savedWtDisable = getEnv("PRX_WT_CACHE_DISABLE");
    savedProjDisable = getEnv("PRX_PROJECTION_DISABLE");
    setEnv("XDG_CACHE_HOME", mkdtempSync(join(tmpdir(), "prx-planclose-proj-")));
    deleteEnv("PRX_WT_CACHE_DISABLE");
    deleteEnv("PRX_PROJECTION_DISABLE");
  });
  afterEach(() => {
    if (savedCacheHome === undefined) deleteEnv("XDG_CACHE_HOME");
    else setEnv("XDG_CACHE_HOME", savedCacheHome);
    if (savedWtDisable === undefined) deleteEnv("PRX_WT_CACHE_DISABLE");
    else setEnv("PRX_WT_CACHE_DISABLE", savedWtDisable);
    if (savedProjDisable === undefined) deleteEnv("PRX_PROJECTION_DISABLE");
    else setEnv("PRX_PROJECTION_DISABLE", savedProjDisable);
  });

  test("closing a unit drops its hydrated issue projection entry (no stale read in the TTL window)", async () => {
    const { runner } = recordingRunner([
      {
        match: (c) => c[0] === "gh" && c[1] === "repo" && c[2] === "view",
        stdout: "bdelanghe/ai-home\n",
        status: 0,
      },
      {
        match: (c) => c[0] === "gh" && c[1] === "issue" && c[2] === "view",
        stdout: JSON.stringify({ number: 1050, state: "OPEN" }),
        status: 0,
      },
      { match: (c) => c[0] === "gh" && c[1] === "issue" && c[2] === "close", status: 0 },
    ]);

    // Simulate a prior board read having hydrated this unit's issue projection.
    putUnit("bdelanghe/ai-home", "GH-1050", { view: { number: 1050, state: "OPEN" } });
    expect(
      getUnit<{ view: { number: number; state?: string | null } }>("bdelanghe/ai-home", "GH-1050"),
    ).toEqual({ view: { number: 1050, state: "OPEN" } });

    const result = await planClose(defaultOptions(), {
      cwd: "/tmp/wt",
      runner,
      beadsSync: makeBeadsSyncStub(0),
      loadAllBeads: noBeadsLoader,
    });
    expect(result.issueClosed).toBe(true);

    // The close actor invalidated the entry — a subsequent read misses (→ re-hydrate fresh).
    expect(
      getUnit<{ view: { number: number; state?: string | null } }>("bdelanghe/ai-home", "GH-1050"),
    ).toBeNull();
  });
});
