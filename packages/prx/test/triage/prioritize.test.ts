import { describe, expect, test } from "bun:test";

import {
  selectCandidates,
  runTriagePrioritize,
  type Candidate,
  type PromptKey,
} from "../../src/triage/prioritize.ts";
import { diffRow } from "../../src/triage/apply.ts";
import type { GhExecResult } from "@bounded-systems/gh";
import type { FallbackIssue } from "../../src/pr-state/github.ts";
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

function scriptedPrompt(keys: PromptKey[]): {
  prompt: (c: Candidate) => Promise<PromptKey>;
  prompted: () => Candidate[];
} {
  const seen: Candidate[] = [];
  let i = 0;
  return {
    prompt: async (c: Candidate) => {
      seen.push(c);
      const key = keys[i] ?? "q";
      i += 1;
      return key;
    },
    prompted: () => seen,
  };
}

const ZERO_SYNC = { exitCode: 0, stdout: "", stderr: "" };

describe("selectCandidates", () => {
  test("includes priority::none rows", () => {
    const c = selectCandidates([issue({ number: 1, labels: [{ name: "priority::none" }] })]);
    expect(c).toHaveLength(1);
    expect(c[0]!.hasPriorityNone).toBe(true);
  });

  test("includes rows with no priority axis label at all", () => {
    const c = selectCandidates([
      issue({ number: 2, labels: [{ name: "type::feature" }, { name: "area::prx" }] }),
    ]);
    expect(c).toHaveLength(1);
    expect(c[0]!.hasPriorityNone).toBe(false);
  });

  test("excludes rows with a scored priority label", () => {
    const c = selectCandidates([
      issue({ number: 3, labels: [{ name: "priority::high" }] }),
      issue({ number: 4, labels: [{ name: "priority::medium" }, { name: "type::bug" }] }),
    ]);
    expect(c).toEqual([]);
  });

  test("sorts by issue number ascending for stable queue order", () => {
    const c = selectCandidates([
      issue({ number: 7, labels: [{ name: "priority::none" }] }),
      issue({ number: 3, labels: [] }),
      issue({ number: 5, labels: [{ name: "priority::none" }] }),
    ]);
    expect(c.map((x) => x.number)).toEqual([3, 5, 7]);
  });

  test("foreign labels do not count as priority axis", () => {
    const c = selectCandidates([
      issue({ number: 9, labels: [{ name: "needs-triage" }, { name: "agent::architect" }] }),
    ]);
    expect(c).toHaveLength(1);
  });
});

describe("runTriagePrioritize", () => {
  function setup(opts: {
    issues: FallbackIssue[];
    keys: PromptKey[];
    execResults?: GhExecResult[];
    syncResult?: { exitCode: number; stdout: string; stderr: string };
  }) {
    const audit: string[] = [];
    const calls: Array<{ group: string; sub: string; args: string[] }> = [];
    let execIndex = 0;
    let syncCalls = 0;
    const { prompt, prompted } = scriptedPrompt(opts.keys);
    const deps = {
      execGh: (eopts: { group: string; subcommand: string; args: string[] }) => {
        calls.push({ group: eopts.group, sub: eopts.subcommand, args: eopts.args });
        const res =
          opts.execResults?.[execIndex] ??
          ({ exitCode: 0, stdout: "", stderr: "", policy: null } as GhExecResult);
        execIndex += 1;
        return res;
      },
      listOpenIssues: () => opts.issues,
      repoNameWithOwner: () => "bdelanghe/ai-home",
      promptDecision: prompt,
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
    };
    const o = makeOutput();
    return { audit, calls, o, deps, prompted, syncCalls: () => syncCalls };
  }

  test("dry-run: prompts but never invokes gh, audit dryRun:true", async () => {
    const { audit, calls, o, deps } = setup({
      issues: [issue({ number: 11, labels: [{ name: "priority::none" }] })],
      keys: ["m"],
    });
    const code = await runTriagePrioritize(
      { repo: "bdelanghe/ai-home", limit: 0, dryRun: true, sync: true },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(audit).toHaveLength(1);
    const entry = JSON.parse(audit[0]!);
    expect(entry.dryRun).toBe(true);
    expect(entry.action).toBe("decide");
    expect(entry.decision).toBe("medium");
    expect(entry.add).toEqual(["priority::medium"]);
    expect(entry.remove).toEqual(["priority::none"]);
    expect(entry.priorityConfidence).toBe("operator");
  });

  test("real-run single decision: one atomic gh issue edit with both label flags", async () => {
    const { calls, o, deps, audit } = setup({
      issues: [
        issue({ number: 42, labels: [{ name: "priority::none" }, { name: "needs-triage" }] }),
      ],
      keys: ["h"],
    });
    const code = await runTriagePrioritize(
      { repo: "bdelanghe/ai-home", limit: 0, dryRun: false, sync: false },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.group).toBe("issue");
    expect(calls[0]!.sub).toBe("edit");
    expect(calls[0]!.args[0]!).toBe("42");
    expect(calls[0]!.args).toContain("--add-label");
    expect(calls[0]!.args).toContain("priority::high");
    expect(calls[0]!.args).toContain("--remove-label");
    expect(calls[0]!.args).toContain("priority::none");
    expect(calls[0]!.args).toContain("--repo");
    expect(calls[0]!.args).toContain("bdelanghe/ai-home");
    const entry = JSON.parse(audit[0]!);
    expect(entry.action).toBe("decide");
    expect(entry.decision).toBe("high");
    expect(entry.priorityConfidence).toBe("operator");
  });

  test("skip: no gh call, audit action:skip", async () => {
    const { calls, audit, o, deps } = setup({
      issues: [issue({ number: 5, labels: [{ name: "priority::none" }] })],
      keys: ["s"],
    });
    const code = await runTriagePrioritize(
      { repo: "bdelanghe/ai-home", limit: 0, dryRun: false, sync: false },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    const entry = JSON.parse(audit[0]!);
    expect(entry.action).toBe("skip");
    expect(entry.decision).toBeUndefined();
  });

  test("quit: stops loop, remaining rows never prompted", async () => {
    const { calls, audit, o, deps, prompted } = setup({
      issues: [
        issue({ number: 1, labels: [{ name: "priority::none" }] }),
        issue({ number: 2, labels: [{ name: "priority::none" }] }),
        issue({ number: 3, labels: [{ name: "priority::none" }] }),
      ],
      keys: ["m", "q"],
    });
    const code = await runTriagePrioritize(
      { repo: "bdelanghe/ai-home", limit: 0, dryRun: false, sync: false },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    // Only issue 1 was decided + edited; issue 2 was quit; issue 3 never seen.
    expect(prompted().map((c) => c.number)).toEqual([1, 2]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0]!).toBe("1");
    // 2 audit rows: one decide (issue 1), one quit (issue 2).
    expect(audit).toHaveLength(2);
    expect(JSON.parse(audit[0]!).action).toBe("decide");
    expect(JSON.parse(audit[1]!).action).toBe("quit");
  });

  test("issue with no priority label: --add-label only, no --remove-label", async () => {
    const { calls, audit, o, deps } = setup({
      issues: [issue({ number: 8, labels: [{ name: "type::feature" }] })],
      keys: ["l"],
    });
    const code = await runTriagePrioritize(
      { repo: "bdelanghe/ai-home", limit: 0, dryRun: false, sync: false },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    expect(calls[0]!.args).toContain("--add-label");
    expect(calls[0]!.args).toContain("priority::low");
    expect(calls[0]!.args).not.toContain("--remove-label");
    const entry = JSON.parse(audit[0]!);
    expect(entry.remove).toEqual([]);
    expect(entry.add).toEqual(["priority::low"]);
  });

  test("gh error: exit=1, audit action:error with stderr captured", async () => {
    const { audit, o, deps } = setup({
      issues: [issue({ number: 7, labels: [{ name: "priority::none" }] })],
      keys: ["c"],
      execResults: [{ exitCode: 1, stdout: "", stderr: "rate limit exceeded", policy: null }],
    });
    const code = await runTriagePrioritize(
      { repo: "bdelanghe/ai-home", limit: 0, dryRun: false, sync: false },
      o.output,
      deps,
    );
    expect(code).toBe(1);
    const entry = JSON.parse(audit[0]!);
    expect(entry.action).toBe("error");
    expect(entry.exitCode).toBe(1);
    expect(entry.stderr).toBe("rate limit exceeded");
  });

  test("--sync (default) with writes calls runBeadsSync once + tail audit entry", async () => {
    const { audit, o, deps, syncCalls } = setup({
      issues: [
        issue({ number: 11, labels: [{ name: "priority::none" }] }),
        issue({ number: 22, labels: [{ name: "priority::none" }] }),
      ],
      keys: ["m", "h"],
      syncResult: { exitCode: 0, stdout: "synced 2 issues\n", stderr: "" },
    });
    const code = await runTriagePrioritize(
      { repo: "bdelanghe/ai-home", limit: 0, dryRun: false, sync: true },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    expect(syncCalls()).toBe(1);
    expect(audit).toHaveLength(3);
    const tail = JSON.parse(audit[audit.length - 1]!);
    expect(tail.action).toBe("sync");
    expect(tail.touchedIssues).toEqual([11, 22]);
    expect(tail.bdExitCode).toBe(0);
    expect(o.log.join("\n")).toContain("OK bd github sync: 2 issue(s) reconciled");
    expect(o.log.join("\n")).toContain("sync=ok");
  });

  test("--no-sync (sync:false) suppresses bd invocation even with writes", async () => {
    const { o, deps, syncCalls } = setup({
      issues: [issue({ number: 5, labels: [{ name: "priority::none" }] })],
      keys: ["m"],
    });
    const code = await runTriagePrioritize(
      { repo: "bdelanghe/ai-home", limit: 0, dryRun: false, sync: false },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    expect(syncCalls()).toBe(0);
    expect(o.log.join("\n")).toContain("sync=skipped");
  });

  test("dry-run suppresses sync regardless of sync flag", async () => {
    const { o, deps, syncCalls } = setup({
      issues: [issue({ number: 5, labels: [{ name: "priority::none" }] })],
      keys: ["m"],
    });
    const code = await runTriagePrioritize(
      { repo: "bdelanghe/ai-home", limit: 0, dryRun: true, sync: true },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    expect(syncCalls()).toBe(0);
    expect(o.log.join("\n")).toContain("sync=skipped");
  });

  test("all-skip queue (zero writes) suppresses sync", async () => {
    const { o, deps, syncCalls } = setup({
      issues: [issue({ number: 5, labels: [{ name: "priority::none" }] })],
      keys: ["s"],
    });
    const code = await runTriagePrioritize(
      { repo: "bdelanghe/ai-home", limit: 0, dryRun: false, sync: true },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    expect(syncCalls()).toBe(0);
    expect(o.log.join("\n")).toContain("sync=skipped");
  });

  test("sync failure flips exit to 1 and records non-zero bdExitCode", async () => {
    const { audit, o, deps, syncCalls } = setup({
      issues: [issue({ number: 7, labels: [{ name: "priority::none" }] })],
      keys: ["c"],
      syncResult: { exitCode: 2, stdout: "", stderr: "bd: token expired" },
    });
    const code = await runTriagePrioritize(
      { repo: "bdelanghe/ai-home", limit: 0, dryRun: false, sync: true },
      o.output,
      deps,
    );
    expect(code).toBe(1);
    expect(syncCalls()).toBe(1);
    const tail = JSON.parse(audit[audit.length - 1]!);
    expect(tail.action).toBe("sync");
    expect(tail.bdExitCode).toBe(2);
    expect(tail.bdStderr).toBe("bd: token expired");
    expect(o.error.join("\n")).toContain("FAIL bd github sync: bd: token expired");
    expect(o.log.join("\n")).toContain("sync=failed");
  });

  test("--repo option overrides repoNameWithOwner resolution", async () => {
    const { calls, o, deps } = setup({
      issues: [issue({ number: 3, labels: [{ name: "priority::none" }] })],
      keys: ["m"],
    });
    const code = await runTriagePrioritize(
      { repo: "other/repo", limit: 0, dryRun: false, sync: false },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    expect(calls[0]!.args).toContain("other/repo");
  });

  test("falls back to repoNameWithOwner when --repo not provided", async () => {
    const { calls, o, deps } = setup({
      issues: [issue({ number: 3, labels: [{ name: "priority::none" }] })],
      keys: ["m"],
    });
    const code = await runTriagePrioritize(
      { limit: 0, dryRun: false, sync: false },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    expect(calls[0]!.args).toContain("bdelanghe/ai-home");
  });

  test("--limit caps candidates after filtering", async () => {
    const { calls, o, deps, prompted } = setup({
      issues: [
        issue({ number: 1, labels: [{ name: "priority::none" }] }),
        issue({ number: 2, labels: [{ name: "priority::none" }] }),
        issue({ number: 3, labels: [{ name: "priority::none" }] }),
      ],
      keys: ["m", "m"],
    });
    const code = await runTriagePrioritize(
      { repo: "bdelanghe/ai-home", limit: 2, dryRun: false, sync: false },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    expect(prompted().map((c) => c.number)).toEqual([1, 2]);
    expect(calls).toHaveLength(2);
  });

  test("empty queue prints friendly message and exits 0", async () => {
    const { o, deps, calls } = setup({
      issues: [issue({ number: 9, labels: [{ name: "priority::high" }] })],
      keys: [],
    });
    const code = await runTriagePrioritize(
      { repo: "bdelanghe/ai-home", limit: 0, dryRun: false, sync: true },
      o.output,
      deps,
    );
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(o.log.join("\n")).toContain("no candidates");
  });
});

describe("GH-957 regression: operator-set priority survives classify→apply", () => {
  test("after prioritize sets priority::high, classifier-emitted priority::none is suppressed by apply", () => {
    // Simulate the post-prioritize state: GH issue now carries priority::high.
    // Subsequent `prx triage classify` runs over the same issue and emits the
    // GH-970 default `priority::none` (no scored rule fired). `prx triage
    // apply` must preserve the operator-set priority::high.
    const decision = diffRow({
      number: 42,
      title: "feat: x",
      url: "https://github.com/bdelanghe/ai-home/issues/42",
      currentLabels: ["priority::high"],
      type: undefined,
      priority: "none",
      priorityConfidence: "unscored",
    });
    expect(decision.kind).toBe("skip");
  });
});
