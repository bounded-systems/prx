import { describe, expect, test } from "bun:test";
import {
  formatIntakeMergeRender,
  intakeMergeOptionsSchema,
  runIntakeMerge,
  type IntakeMergeOptions,
} from "../../src/intake/intake-merge.ts";
import type { BdIssueCloseResult } from "../../src/tools/bd_issue_close.ts";
import type { GhExecResult } from "@bounded-systems/gh";
import type { GhIssueCloseResult } from "../../src/tools/gh_issue_close.ts";
import type { BeadsRecord } from "../../src/triage/triage.ts";

type GhCallTag = { kind: "gh"; subcommand: string; args: string[] };
type CloseCallTag = { kind: "close"; number: number; reason?: string | undefined; repo?: string | undefined };
type BdCallTag = {
  kind: "bd";
  subcommand: string;
  args: string[];
  state?: string | undefined;
  role?: string | undefined;
};
type BdCloseCallTag = { kind: "bd-close"; id: string; reason?: string | undefined };
type CallTag = GhCallTag | CloseCallTag | BdCallTag | BdCloseCallTag;

function bdCloseOk(stdout = ""): BdIssueCloseResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function bdCloseFail(stderr: string, code = 1): BdIssueCloseResult {
  return { exitCode: code, stdout: "", stderr };
}

// GH-296 / prx-82b: the bd↔bd pointer-note write now runs `prx beads update <id>
// --notes …` through the daemon (a sync runner). The fake records the equivalent
// old `bd update` BdCallTag shape so the existing assertions hold.
const bdRunOk = () => ({ status: 0, stdout: "", stderr: "" });
function recordingRun(calls: CallTag[]) {
  return ((cmd: string[]) => {
    calls.push({ kind: "bd", subcommand: cmd[2] ?? "", args: cmd.slice(3), state: "planning", role: "planner" });
    return bdRunOk();
  }) as never;
}

function bdRecord(overrides: Partial<BeadsRecord> = {}): BeadsRecord {
  return {
    id: "ai-home-aaaaa",
    title: "test record",
    description: "",
    status: "open",
    priority: null,
    issueType: "",
    externalRef: null,
    externalRefs: {},
    metadata: null,
    externalIssueNumber: null,
    sourceSystem: null,
    updatedAt: null,
    notes: null,
    ...overrides,
  };
}

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

function makeOpts(
  overrides: Partial<IntakeMergeOptions> = {},
): IntakeMergeOptions {
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
    const policyCalls: Array<{ state?: string | undefined; role?: string | undefined; subcommand?: string | undefined }> = [];
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

  test("mixed-backend pair (bd dup + GH canonical) is refused with cross-backend hint", () => {
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
    expect(errors.join("\n")).toContain("cross-backend merge is out of scope");
    expect(errors.join("\n")).toContain("bd dup + gh canonical");
  });

  test("mixed-backend pair (GH dup + bd canonical) is refused symmetrically", () => {
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
    expect(errors.join("\n")).toContain("cross-backend merge is out of scope");
    expect(errors.join("\n")).toContain("gh dup + bd canonical");
  });
});

describe("runIntakeMerge — bd↔bd arm", () => {
  test("happy path: preflight → append marker → bd close --reason duplicate", () => {
    const calls: CallTag[] = [];
    const exitCode = runIntakeMerge(
      makeOpts({ dupId: "ai-home-dup", canonicalId: "ai-home-can" }),
      { log: () => undefined, error: () => undefined },
      {
        run: recordingRun(calls),
        execBdIssueClose: ((opts: { id: string; reason?: string }) => {
          calls.push({ kind: "bd-close", id: opts.id, reason: opts.reason });
          return bdCloseOk();
        }) as never,
        loadAllBeads: (() => [
          bdRecord({ id: "ai-home-dup", status: "open", externalRef: null, notes: null }),
        ]) as never,
      },
    );
    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      kind: "bd",
      subcommand: "update",
      state: "planning",
      role: "planner",
    });
    const updateArgs = (calls[0] as BdCallTag).args;
    expect(updateArgs[0]).toBe("ai-home-dup");
    expect(updateArgs).toContain("--notes");
    const newNotes = updateArgs[updateArgs.indexOf("--notes") + 1]!;
    expect(newNotes).toContain("[prx-intake-merge sha256-prefix=");
    expect(newNotes).toContain("Merging into ai-home-can");
    expect(calls[1]).toEqual({
      kind: "bd-close",
      id: "ai-home-dup",
      reason: "duplicate",
    });
  });

  test("already-closed dup short-circuits with idempotent success", () => {
    const calls: CallTag[] = [];
    const logs: string[] = [];
    const exitCode = runIntakeMerge(
      makeOpts({ dupId: "ai-home-dup", canonicalId: "ai-home-can" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        run: recordingRun(calls),
        execBdIssueClose: ((opts: { id: string }) => {
          calls.push({ kind: "bd-close", id: opts.id });
          return bdCloseOk();
        }) as never,
        loadAllBeads: (() => [
          bdRecord({ id: "ai-home-dup", status: "closed", notes: "prior content" }),
        ]) as never,
      },
    );
    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(0);
    expect(logs.join("\n")).toContain("already closed");
  });

  test("dup with external_ref is refused with cross-backend pointer hint", () => {
    const errors: string[] = [];
    const exitCode = runIntakeMerge(
      makeOpts({ dupId: "ai-home-dup", canonicalId: "ai-home-can" }),
      { log: () => undefined, error: (l) => errors.push(l) },
      {
        run: bdRunOk as never,
        execBdIssueClose: (() => bdCloseOk()) as never,
        loadAllBeads: (() => [
          bdRecord({
            id: "ai-home-dup",
            externalRef: "https://github.com/o/r/issues/200",
          }),
        ]) as never,
      },
    );
    expect(exitCode).toBe(1);
    const stderr = errors.join("\n");
    expect(stderr).toContain("pinned to a GH issue");
    expect(stderr).toContain("prx intake merge GH-N GH-M");
  });

  test("--reason 'not planned' is forwarded to bd close call", () => {
    let closeReason: string | undefined;
    runIntakeMerge(
      makeOpts({
        dupId: "ai-home-dup",
        canonicalId: "ai-home-can",
        reason: "not planned",
      }),
      { log: () => undefined, error: () => undefined },
      {
        run: bdRunOk as never,
        execBdIssueClose: ((opts: { reason?: string }) => {
          closeReason = opts.reason;
          return bdCloseOk();
        }) as never,
        loadAllBeads: (() => [bdRecord({ id: "ai-home-dup", notes: null })]) as never,
      },
    );
    expect(closeReason).toBe("not planned");
  });

  test("--reason 'duplicate' (default) flows through to bd close", () => {
    let closeReason: string | undefined;
    runIntakeMerge(
      makeOpts({ dupId: "ai-home-dup", canonicalId: "ai-home-can" }),
      { log: () => undefined, error: () => undefined },
      {
        run: bdRunOk as never,
        execBdIssueClose: ((opts: { reason?: string }) => {
          closeReason = opts.reason;
          return bdCloseOk();
        }) as never,
        loadAllBeads: (() => [bdRecord({ id: "ai-home-dup", notes: null })]) as never,
      },
    );
    expect(closeReason).toBe("duplicate");
  });

  test("--label is refused on the bd arm", () => {
    const errors: string[] = [];
    const exitCode = runIntakeMerge(
      makeOpts({
        dupId: "ai-home-dup",
        canonicalId: "ai-home-can",
        label: "dedupe::merged",
      }),
      { log: () => undefined, error: (l) => errors.push(l) },
      {
        run: bdRunOk as never,
        execBdIssueClose: (() => bdCloseOk()) as never,
        loadAllBeads: (() => [bdRecord({ id: "ai-home-dup", notes: null })]) as never,
      },
    );
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--label is GH-only");
  });

  test("missing bd dup record refuses without spawning update/close", () => {
    const calls: CallTag[] = [];
    const errors: string[] = [];
    const exitCode = runIntakeMerge(
      makeOpts({ dupId: "ai-home-missing", canonicalId: "ai-home-can" }),
      { log: () => undefined, error: (l) => errors.push(l) },
      {
        run: recordingRun(calls),
        execBdIssueClose: ((opts: { id: string }) => {
          calls.push({ kind: "bd-close", id: opts.id });
          return bdCloseOk();
        }) as never,
        loadAllBeads: (() => []) as never,
      },
    );
    expect(exitCode).toBe(1);
    expect(calls).toHaveLength(0);
    expect(errors.join("\n")).toContain("no bd record");
    expect(errors.join("\n")).toContain("ai-home-missing");
  });

  test("close failure after successful append surfaces partial-state warning", () => {
    const calls: CallTag[] = [];
    const errors: string[] = [];
    const exitCode = runIntakeMerge(
      makeOpts({ dupId: "ai-home-dup", canonicalId: "ai-home-can" }),
      { log: () => undefined, error: (l) => errors.push(l) },
      {
        run: recordingRun(calls),
        execBdIssueClose: ((opts: { id: string }) => {
          calls.push({ kind: "bd-close", id: opts.id });
          return bdCloseFail("bd close: unauthorized", 3);
        }) as never,
        loadAllBeads: (() => [bdRecord({ id: "ai-home-dup", notes: null })]) as never,
      },
    );
    expect(exitCode).toBe(3);
    expect(calls).toHaveLength(2);
    const stderr = errors.join("\n");
    expect(stderr).toContain("bd close: unauthorized");
    expect(stderr).toContain("partial state");
    expect(stderr).toContain("ai-home-dup");
  });

  test("re-run with same body is idempotent: skips bd update but still closes", () => {
    // Pre-seed bd notes with the marker that the first run would have written.
    const firstRunCalls: CallTag[] = [];
    runIntakeMerge(
      makeOpts({ dupId: "ai-home-dup", canonicalId: "ai-home-can" }),
      { log: () => undefined, error: () => undefined },
      {
        run: recordingRun(firstRunCalls),
        execBdIssueClose: (() => bdCloseOk()) as never,
        loadAllBeads: (() => [bdRecord({ id: "ai-home-dup", notes: null })]) as never,
      },
    );
    const seededNotes =
      (firstRunCalls[0] as BdCallTag).args[
        (firstRunCalls[0] as BdCallTag).args.indexOf("--notes") + 1
      ]!;

    const calls: CallTag[] = [];
    runIntakeMerge(
      makeOpts({ dupId: "ai-home-dup", canonicalId: "ai-home-can" }),
      { log: () => undefined, error: () => undefined },
      {
        run: recordingRun(calls),
        execBdIssueClose: ((opts: { id: string }) => {
          calls.push({ kind: "bd-close", id: opts.id });
          return bdCloseOk();
        }) as never,
        loadAllBeads: (() => [bdRecord({ id: "ai-home-dup", notes: seededNotes })]) as never,
      },
    );
    // No bd update — marker already present. Still calls bd-close.
    expect(calls.filter((c) => c.kind === "bd")).toHaveLength(0);
    expect(calls.filter((c) => c.kind === "bd-close")).toHaveLength(1);
  });

  test("dry-run renders bd update + bd close argvs without spawning", () => {
    const calls: CallTag[] = [];
    const logs: string[] = [];
    const exitCode = runIntakeMerge(
      makeOpts({
        dupId: "ai-home-dup",
        canonicalId: "ai-home-can",
        dryRun: true,
      }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        run: recordingRun(calls),
        execBdIssueClose: ((opts: { id: string }) => {
          calls.push({ kind: "bd-close", id: opts.id });
          return bdCloseOk();
        }) as never,
        loadAllBeads: (() => [bdRecord({ id: "ai-home-dup", notes: null })]) as never,
      },
    );
    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(0);
    const out = logs[0]!;
    expect(out).toContain("(dry-run)");
    expect(out).toContain("dup:        ai-home-dup");
    expect(out).toContain("canonical:  ai-home-can");
    expect(out).toContain("backend:    bd");
    expect(out).toContain("would run:");
    expect(out).toContain("bd update ai-home-dup --notes");
    expect(out).toContain("bd close ai-home-dup --reason duplicate");
  });

  test("dry-run json output for bd arm carries backend=bd and both argvs", () => {
    const logs: string[] = [];
    runIntakeMerge(
      makeOpts({
        dupId: "ai-home-dup",
        canonicalId: "ai-home-can",
        dryRun: true,
        format: "json",
      }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        run: bdRunOk as never,
        execBdIssueClose: (() => bdCloseOk()) as never,
        loadAllBeads: (() => [bdRecord({ id: "ai-home-dup", notes: null })]) as never,
      },
    );
    const parsed = JSON.parse(logs[0]!) as {
      backend: "bd";
      dupId: string;
      canonicalId: string;
      marker: string;
      body: string;
      bdUpdateArgv: string[];
      bdCloseArgv: string[];
      reason: string;
      dryRun: boolean;
    };
    expect(parsed.backend).toBe("bd");
    expect(parsed.dupId).toBe("ai-home-dup");
    expect(parsed.canonicalId).toBe("ai-home-can");
    expect(parsed.body).toBe("Merging into ai-home-can");
    expect(parsed.marker).toMatch(/^\[prx-intake-merge sha256-prefix=[0-9a-f]{8}\]$/);
    expect(parsed.reason).toBe("duplicate");
    expect(parsed.bdUpdateArgv[0]).toBe("ai-home-dup");
    expect(parsed.bdUpdateArgv).toContain("--notes");
    expect(parsed.bdCloseArgv[0]).toBe("close");
    expect(parsed.bdCloseArgv).toContain("--reason");
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
    const editCall = calls.find(
      (c) => c.kind === "gh" && c.subcommand === "edit",
    ) as GhCallTag;
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
