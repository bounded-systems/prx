import { describe, expect, test } from "bun:test";
import {
  formatIntakeMergeRender,
  intakeMergeOptionsSchema,
  runIntakeMerge,
  type IntakeMergeOptions,
} from "../../src/intake/intake-merge.ts";
import type { GhExecResult } from "@bounded-systems/gh";
import type { GhIssueCloseResult } from "../../src/tools/gh_issue_close.ts";

type GhCallTag = { kind: "gh"; subcommand: string; args: string[] };
type CloseCallTag = {
  kind: "close";
  number: number;
  reason?: string | undefined;
  repo?: string | undefined;
};
type CallTag = GhCallTag | CloseCallTag;

const VIEW_OPEN_EMPTY = JSON.stringify({ state: "OPEN", comments: [] });

function ghViewOpenEmpty(): GhExecResult {
  return { exitCode: 0, stdout: VIEW_OPEN_EMPTY, stderr: "", policy: null };
}

function makeExecGh(
  calls: CallTag[],
  perSubcommand: Partial<Record<string, () => GhExecResult>> = {},
) {
  return ((opts: { subcommand: string; args: string[] }) => {
    calls.push({ kind: "gh", subcommand: opts.subcommand, args: opts.args });
    const fn = perSubcommand[opts.subcommand];
    if (fn) return fn();
    if (opts.subcommand === "view") return ghViewOpenEmpty();
    return ghOk();
  }) as never;
}

function makeOpts(overrides: Partial<IntakeMergeOptions> = {}): IntakeMergeOptions {
  return intakeMergeOptionsSchema.parse({
    dupId: "GH-100",
    canonicalId: "GH-200",
    ...overrides,
  });
}

function ghOk(stdout = ""): GhExecResult {
  return { exitCode: 0, stdout, stderr: "", policy: null };
}

function ghFail(stderr: string, code = 1): GhExecResult {
  return { exitCode: code, stdout: "", stderr, policy: null };
}

function closeOk(stdout = ""): GhIssueCloseResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function closeFail(stderr: string, code = 1): GhIssueCloseResult {
  return { exitCode: code, stdout: "", stderr };
}

describe("runIntakeMerge — happy path", () => {
  test("reads dup state, posts comment, then closes with default --reason duplicate", () => {
    const calls: CallTag[] = [];
    const exitCode = runIntakeMerge(
      makeOpts({ dupId: "GH-100", canonicalId: "GH-200" }),
      { log: () => undefined, error: () => undefined },
      {
        execGh: makeExecGh(calls),
        execGhIssueClose: ((opts: { number: number; reason?: string; repo?: string }) => {
          calls.push({ kind: "close", number: opts.number, reason: opts.reason, repo: opts.repo });
          return closeOk();
        }) as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ kind: "gh", subcommand: "view" });
    expect(calls[1]).toMatchObject({ kind: "gh", subcommand: "comment" });
    const commentArgs = (calls[1] as GhCallTag).args;
    expect(commentArgs[0]).toBe("100");
    expect(commentArgs).toContain("--body");
    expect(commentArgs[commentArgs.indexOf("--body") + 1]).toBe("Merging into #200");
    expect(calls[2]).toEqual({
      kind: "close",
      number: 100,
      reason: "duplicate",
      repo: undefined,
    });
  });

  test("comment uses planning/executor policy slot", () => {
    const policyCalls: Array<{
      state?: string | undefined;
      role?: string | undefined;
      subcommand?: string | undefined;
    }> = [];
    runIntakeMerge(
      makeOpts(),
      { log: () => undefined, error: () => undefined },
      {
        execGh: ((opts: { state?: string; role?: string; subcommand: string }) => {
          policyCalls.push({ state: opts.state, role: opts.role, subcommand: opts.subcommand });
          if (opts.subcommand === "view") return ghViewOpenEmpty();
          return ghOk();
        }) as never,
        execGhIssueClose: (() => closeOk()) as never,
      },
    );
    const commentCall = policyCalls.find((c) => c.subcommand === "comment");
    expect(commentCall).toEqual({ state: "planning", role: "executor", subcommand: "comment" });
  });
});

describe("runIntakeMerge — comment failure", () => {
  test("aborts before close, propagates exit code, no close call recorded", () => {
    const calls: CallTag[] = [];
    const errors: string[] = [];
    const exitCode = runIntakeMerge(
      makeOpts({ dupId: "GH-100", canonicalId: "GH-200" }),
      { log: () => undefined, error: (l) => errors.push(l) },
      {
        execGh: makeExecGh(calls, {
          comment: () => ghFail("permission denied", 2),
        }),
        execGhIssueClose: ((opts: { number: number }) => {
          calls.push({ kind: "close", number: opts.number });
          return closeOk();
        }) as never,
      },
    );

    expect(exitCode).toBe(2);
    const closeCalls = calls.filter((c) => c.kind === "close");
    expect(closeCalls).toHaveLength(0);
    expect(errors.join("\n")).toContain("permission denied");
  });
});

describe("runIntakeMerge — close failure", () => {
  test("comment succeeds, close fails, partial-state warning on stderr, exit propagates", () => {
    const calls: CallTag[] = [];
    const errors: string[] = [];
    const exitCode = runIntakeMerge(
      makeOpts({ dupId: "GH-100", canonicalId: "GH-200" }),
      { log: () => undefined, error: (l) => errors.push(l) },
      {
        execGh: makeExecGh(calls),
        execGhIssueClose: ((opts: { number: number }) => {
          calls.push({ kind: "close", number: opts.number });
          return closeFail("close blocked by branch protection", 3);
        }) as never,
      },
    );

    expect(exitCode).toBe(3);
    expect(calls).toHaveLength(3);
    const stderr = errors.join("\n");
    expect(stderr).toContain("close blocked by branch protection");
    expect(stderr).toContain("partial state");
    expect(stderr).toContain("GH-100");
  });

  test("does not attempt label edit when close fails", () => {
    const calls: CallTag[] = [];
    runIntakeMerge(
      makeOpts({ label: "dedupe::merged" }),
      { log: () => undefined, error: () => undefined },
      {
        execGh: makeExecGh(calls),
        execGhIssueClose: (() => closeFail("nope")) as never,
      },
    );
    expect(calls.filter((c) => c.kind === "gh" && c.subcommand === "edit")).toHaveLength(0);
  });
});

describe("runIntakeMerge — dry-run", () => {
  test("renders argvs (view + comment + close), no spawn calls, exit 0", () => {
    const calls: CallTag[] = [];
    const logs: string[] = [];
    const exitCode = runIntakeMerge(
      makeOpts({ dupId: "GH-100", canonicalId: "GH-200", dryRun: true }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        execGh: makeExecGh(calls),
        execGhIssueClose: ((opts: { number: number }) => {
          calls.push({ kind: "close", number: opts.number });
          return closeOk();
        }) as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(0);
    const out = logs[0]!;
    expect(out).toContain("dry-run");
    expect(out).toContain("dup:        GH-100");
    expect(out).toContain("canonical:  GH-200");
    expect(out).toContain("preflight:  (skipped — dry-run)");
    expect(out).toContain("gh issue view 100");
    expect(out).toContain("gh issue comment 100");
    expect(out).toContain("gh issue close 100 --reason duplicate");
  });

  test("dry-run --label includes the edit argv", () => {
    const logs: string[] = [];
    runIntakeMerge(
      makeOpts({ dryRun: true, label: "dedupe::merged" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        execGh: (() => ghOk()) as never,
        execGhIssueClose: (() => closeOk()) as never,
      },
    );
    expect(logs[0]).toContain("--add-label dedupe::merged");
  });

  test("dry-run with explicit --reason 'not planned' renders space form", () => {
    const logs: string[] = [];
    runIntakeMerge(
      makeOpts({ dryRun: true, reason: "not planned" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        execGh: (() => ghOk()) as never,
        execGhIssueClose: (() => closeOk()) as never,
      },
    );
    expect(logs[0]).toContain("gh issue close 100 --reason 'not planned'");
  });

  test("dry-run json output is valid JSON with expected shape", () => {
    const logs: string[] = [];
    runIntakeMerge(
      makeOpts({ dryRun: true, format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        execGh: (() => ghOk()) as never,
        execGhIssueClose: (() => closeOk()) as never,
      },
    );
    const parsed = JSON.parse(logs[0]!) as {
      dupNumber: number;
      canonicalNumber: number;
      dryRun: boolean;
      comment: { body: string };
      close: { reason: string };
      preflight: { skipped: boolean; argv: string[] };
    };
    expect(parsed.dupNumber).toBe(100);
    expect(parsed.canonicalNumber).toBe(200);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.comment.body).toBe("Merging into #200");
    expect(parsed.close.reason).toBe("duplicate");
    expect(parsed.preflight.skipped).toBe(true);
    expect(parsed.preflight.argv).toEqual(["issue", "view", "100", "--json", "state,comments"]);
  });
});

describe("runIntakeMerge — --label", () => {
  test("edit follows view + comment + close in order", () => {
    const calls: CallTag[] = [];
    const exitCode = runIntakeMerge(
      makeOpts({ label: "dedupe::merged" }),
      { log: () => undefined, error: () => undefined },
      {
        execGh: makeExecGh(calls),
        execGhIssueClose: ((opts: { number: number }) => {
          calls.push({ kind: "close", number: opts.number });
          return closeOk();
        }) as never,
      },
    );
    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(4);
    expect(calls[0]).toMatchObject({ kind: "gh", subcommand: "view" });
    expect(calls[1]).toMatchObject({ kind: "gh", subcommand: "comment" });
    expect(calls[2]).toMatchObject({ kind: "close" });
    expect(calls[3]).toMatchObject({ kind: "gh", subcommand: "edit" });
    const editArgs = (calls[3] as GhCallTag).args;
    expect(editArgs).toContain("--add-label");
    expect(editArgs[editArgs.indexOf("--add-label") + 1]).toBe("dedupe::merged");
  });

  test("label-failure is non-fatal (close already succeeded)", () => {
    const errors: string[] = [];
    let editCalls = 0;
    const exitCode = runIntakeMerge(
      makeOpts({ label: "dedupe::merged" }),
      { log: () => undefined, error: (l) => errors.push(l) },
      {
        execGh: ((opts: { subcommand: string }) => {
          if (opts.subcommand === "view") return ghViewOpenEmpty();
          if (opts.subcommand === "edit") {
            editCalls++;
            return ghFail("label not found", 1);
          }
          return ghOk();
        }) as never,
        execGhIssueClose: (() => closeOk()) as never,
      },
    );
    expect(exitCode).toBe(0);
    expect(editCalls).toBe(1);
    expect(errors.join("\n")).toContain("--add-label 'dedupe::merged' failed");
  });
});

describe("runIntakeMerge — id rejection", () => {
  test("shell-metachar input throws via shared resolver", () => {
    const errors: string[] = [];
    const exitCode = runIntakeMerge(
      makeOpts({ dupId: "foo;rm" }),
      { log: () => undefined, error: (l) => errors.push(l) },
      {
        execGh: (() => ghOk()) as never,
        execGhIssueClose: (() => closeOk()) as never,
      },
    );
    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("invalid characters");
  });

  test("bd dup id is refused — the bd backend was removed (GH-1012)", () => {
    const errors: string[] = [];
    const exitCode = runIntakeMerge(
      makeOpts({ dupId: "ai-home-abc123", canonicalId: "GH-200" }),
      { log: () => undefined, error: (l) => errors.push(l) },
      {
        execGh: (() => ghOk()) as never,
        execGhIssueClose: (() => closeOk()) as never,
      },
    );
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("the bd backend has been removed");
  });

  test("bd canonical id is refused symmetrically", () => {
    const errors: string[] = [];
    const exitCode = runIntakeMerge(
      makeOpts({ dupId: "GH-100", canonicalId: "ai-home-xyz" }),
      { log: () => undefined, error: (l) => errors.push(l) },
      {
        execGh: (() => ghOk()) as never,
        execGhIssueClose: (() => closeOk()) as never,
      },
    );
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("the bd backend has been removed");
  });
});

describe("runIntakeMerge — flag passthrough", () => {
  test("--reason duplicate flag passes through to close call", () => {
    let closeReason: string | undefined;
    runIntakeMerge(
      makeOpts({ reason: "duplicate" }),
      { log: () => undefined, error: () => undefined },
      {
        execGh: ((opts: { subcommand: string }) => {
          if (opts.subcommand === "view") return ghViewOpenEmpty();
          return ghOk();
        }) as never,
        execGhIssueClose: ((opts: { reason?: string }) => {
          closeReason = opts.reason;
          return closeOk();
        }) as never,
      },
    );
    expect(closeReason).toBe("duplicate");
  });

  test("--reason 'not planned' (space form) passes through unchanged to close call", () => {
    let closeReason: string | undefined;
    runIntakeMerge(
      makeOpts({ reason: "not planned" }),
      { log: () => undefined, error: () => undefined },
      {
        execGh: ((opts: { subcommand: string }) => {
          if (opts.subcommand === "view") return ghViewOpenEmpty();
          return ghOk();
        }) as never,
        execGhIssueClose: ((opts: { reason?: string }) => {
          closeReason = opts.reason;
          return closeOk();
        }) as never,
      },
    );
    expect(closeReason).toBe("not planned");
  });

  test("--template substitutes ${canonical} placeholder", () => {
    const calls: CallTag[] = [];
    runIntakeMerge(
      makeOpts({
        canonicalId: "GH-555",
        template: "dup of #${canonical}; closing per dedupe norm",
      }),
      { log: () => undefined, error: () => undefined },
      {
        execGh: makeExecGh(calls),
        execGhIssueClose: (() => closeOk()) as never,
      },
    );
    const commentCall = calls.find(
      (c) => c.kind === "gh" && c.subcommand === "comment",
    ) as GhCallTag;
    const commentArgs = commentCall.args;
    expect(commentArgs[commentArgs.indexOf("--body") + 1]).toBe(
      "dup of #555; closing per dedupe norm",
    );
  });

  test("URL form supplies --repo to all gh calls", () => {
    const calls: CallTag[] = [];
    let closeRepo: string | undefined;
    runIntakeMerge(
      makeOpts({
        dupId: "https://github.com/o/r/issues/100",
        canonicalId: "GH-200",
        label: "x",
      }),
      { log: () => undefined, error: () => undefined },
      {
        execGh: makeExecGh(calls),
        execGhIssueClose: ((opts: { repo?: string }) => {
          closeRepo = opts.repo;
          return closeOk();
        }) as never,
      },
    );
    const commentCall = calls.find(
      (c) => c.kind === "gh" && c.subcommand === "comment",
    ) as GhCallTag;
    const commentArgs = commentCall.args;
    expect(commentArgs).toContain("--repo");
    expect(commentArgs[commentArgs.indexOf("--repo") + 1]).toBe("o/r");
    expect(closeRepo).toBe("o/r");
    const editCall = calls.find((c) => c.kind === "gh" && c.subcommand === "edit") as GhCallTag;
    const editArgs = editCall.args;
    expect(editArgs).toContain("--repo");
    expect(editArgs[editArgs.indexOf("--repo") + 1]).toBe("o/r");
  });

  test("explicit --repo wins over URL-form repo", () => {
    let closeRepo: string | undefined;
    runIntakeMerge(
      makeOpts({
        dupId: "https://github.com/o/r/issues/100",
        canonicalId: "GH-200",
        repo: "explicit/repo",
      }),
      { log: () => undefined, error: () => undefined },
      {
        execGh: ((opts: { subcommand: string }) => {
          if (opts.subcommand === "view") return ghViewOpenEmpty();
          return ghOk();
        }) as never,
        execGhIssueClose: ((opts: { repo?: string }) => {
          closeRepo = opts.repo;
          return closeOk();
        }) as never,
      },
    );
    expect(closeRepo).toBe("explicit/repo");
  });
});

describe("runIntakeMerge — pre-flight idempotency", () => {
  test("closed dup short-circuits: exit 0, no comment, no close", () => {
    const calls: CallTag[] = [];
    const logs: string[] = [];
    const closedViewBody = JSON.stringify({
      state: "CLOSED",
      comments: [{ body: "Merging into #200" }],
    });
    const exitCode = runIntakeMerge(
      makeOpts({ dupId: "GH-100", canonicalId: "GH-200" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        execGh: ((opts: { subcommand: string; args: string[] }) => {
          calls.push({ kind: "gh", subcommand: opts.subcommand, args: opts.args });
          if (opts.subcommand === "view") {
            return { exitCode: 0, stdout: closedViewBody, stderr: "", policy: null };
          }
          return ghOk();
        }) as never,
        execGhIssueClose: ((opts: { number: number }) => {
          calls.push({ kind: "close", number: opts.number });
          return closeOk();
        }) as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: "gh", subcommand: "view" });
    expect(logs.join("\n")).toContain("already closed");
  });

  test("existing matching pointer skips comment but still closes", () => {
    const calls: CallTag[] = [];
    const openWithPointer = JSON.stringify({
      state: "OPEN",
      comments: [{ body: "Merging into #200" }],
    });
    const exitCode = runIntakeMerge(
      makeOpts({ dupId: "GH-100", canonicalId: "GH-200" }),
      { log: () => undefined, error: () => undefined },
      {
        execGh: ((opts: { subcommand: string; args: string[] }) => {
          calls.push({ kind: "gh", subcommand: opts.subcommand, args: opts.args });
          if (opts.subcommand === "view") {
            return { exitCode: 0, stdout: openWithPointer, stderr: "", policy: null };
          }
          return ghOk();
        }) as never,
        execGhIssueClose: ((opts: { number: number; reason?: string }) => {
          calls.push({ kind: "close", number: opts.number, reason: opts.reason });
          return closeOk();
        }) as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ kind: "gh", subcommand: "view" });
    expect(calls[1]).toMatchObject({ kind: "close" });
    expect(calls.find((c) => c.kind === "gh" && c.subcommand === "comment")).toBeUndefined();
  });

  test("mismatched comment body still posts a fresh pointer", () => {
    const calls: CallTag[] = [];
    const openWithUnrelated = JSON.stringify({
      state: "OPEN",
      comments: [{ body: "unrelated discussion" }],
    });
    const exitCode = runIntakeMerge(
      makeOpts({ dupId: "GH-100", canonicalId: "GH-200" }),
      { log: () => undefined, error: () => undefined },
      {
        execGh: ((opts: { subcommand: string; args: string[] }) => {
          calls.push({ kind: "gh", subcommand: opts.subcommand, args: opts.args });
          if (opts.subcommand === "view") {
            return { exitCode: 0, stdout: openWithUnrelated, stderr: "", policy: null };
          }
          return ghOk();
        }) as never,
        execGhIssueClose: ((opts: { number: number }) => {
          calls.push({ kind: "close", number: opts.number });
          return closeOk();
        }) as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ kind: "gh", subcommand: "view" });
    expect(calls[1]).toMatchObject({ kind: "gh", subcommand: "comment" });
    expect(calls[2]).toMatchObject({ kind: "close" });
  });

  test("view step failure propagates exit code without spawning comment/close", () => {
    const calls: CallTag[] = [];
    const errors: string[] = [];
    const exitCode = runIntakeMerge(
      makeOpts({ dupId: "GH-100", canonicalId: "GH-200" }),
      { log: () => undefined, error: (l) => errors.push(l) },
      {
        execGh: ((opts: { subcommand: string; args: string[] }) => {
          calls.push({ kind: "gh", subcommand: opts.subcommand, args: opts.args });
          if (opts.subcommand === "view") return ghFail("issue not found", 4);
          return ghOk();
        }) as never,
        execGhIssueClose: ((opts: { number: number }) => {
          calls.push({ kind: "close", number: opts.number });
          return closeOk();
        }) as never,
      },
    );

    expect(exitCode).toBe(4);
    expect(calls).toHaveLength(1);
    expect(errors.join("\n")).toContain("issue not found");
  });
});

describe("formatIntakeMergeRender", () => {
  test("plain dry-run includes 'would run:' header and preflight line", () => {
    const out = formatIntakeMergeRender(
      {
        backend: "gh",
        dupNumber: 100,
        canonicalNumber: 200,
        repo: undefined,
        preflight: {
          argv: ["issue", "view", "100", "--json", "state,comments"],
          closed: false,
          pointerSeen: false,
          skipped: true,
        },
        comment: {
          argv: ["issue", "comment", "100", "--body", "Merging into #200"],
          body: "Merging into #200",
        },
        close: {
          argv: ["issue", "close", "100", "--reason", "duplicate"],
          reason: "duplicate",
        },
        dryRun: true,
        exitCode: 0,
      },
      "plain",
    );
    expect(out).toContain("(dry-run)");
    expect(out).toContain("would run:");
    expect(out).toContain("preflight:  (skipped — dry-run)");
    expect(out).toContain("gh issue view 100");
    expect(out).toContain("gh issue comment 100");
  });

  test("plain non-dry-run with label shows label line + preflight summary", () => {
    const out = formatIntakeMergeRender(
      {
        backend: "gh",
        dupNumber: 100,
        canonicalNumber: 200,
        repo: undefined,
        preflight: {
          argv: ["issue", "view", "100", "--json", "state,comments"],
          closed: false,
          pointerSeen: false,
          skipped: false,
        },
        comment: {
          argv: ["issue", "comment", "100", "--body", "Merging into #200"],
          body: "Merging into #200",
        },
        close: {
          argv: ["issue", "close", "100", "--reason", "duplicate"],
          reason: "duplicate",
        },
        label: { argv: ["issue", "edit", "100", "--add-label", "x"], name: "x" },
        dryRun: false,
        exitCode: 0,
      },
      "plain",
    );
    expect(out).not.toContain("(dry-run)");
    expect(out).toContain("label:      x");
    expect(out).toContain("preflight:  closed=false pointer=false");
  });
});
