import { describe, expect, test } from "bun:test";
import {
  composeBody,
  composeStructuredBody,
  composeTitle,
  inferScope,
  IntakeTitleMismatchError,
  intakeOptionsSchema,
  resolveBody,
  resolveSurfacedFrom,
  runIntake,
  type IntakeOptions,
} from "../../src/intake/intake.ts";
import type { BdExecResult } from "@bounded-systems/bd";
import type { PublishCoreResult, BeadsPublishOptions, BeadsPublishDeps } from "../../src/beads/publish.ts";

// Helper: stub bd create that returns a fixed bd id so runIntake can
// proceed past the bd-create step. Returns a fresh stub per test.
function makeBdCreateStub(bdId = "ai-home-001"): {
  invocations: Array<{ subcommand: string; args: string[]; state?: string; role?: string }>;
  exec: (opts: { subcommand: string; args: string[]; state?: string; role?: string }) => BdExecResult;
} {
  const invocations: Array<{ subcommand: string; args: string[]; state?: string; role?: string }> = [];
  return {
    invocations,
    exec: (opts) => {
      invocations.push(opts);
      if (opts.subcommand === "create") {
        return { exitCode: 0, stdout: `${bdId}\n`, stderr: "", policy: null };
      }
      return { exitCode: 0, stdout: "", stderr: "", policy: null };
    },
  };
}

function makeOptions(overrides: Partial<IntakeOptions> = {}): IntakeOptions {
  return {
    type: "task",
    title: "test title",
    bodyStdin: false,
    labels: [],
    assignees: [],
    dryRun: false,
    yes: false,
    format: "plain",
    ...overrides,
  };
}

describe("composeTitle", () => {
  test("formats type prefix without scope", () => {
    expect(composeTitle("bug", "broken thing")).toBe("bug: broken thing");
  });

  test("formats type(scope) prefix when scope is present", () => {
    expect(composeTitle("feature", "read-only auth pattern", "aws")).toBe(
      "feature(aws): read-only auth pattern",
    );
  });

  test("trims whitespace-only scope to bare prefix", () => {
    expect(composeTitle("feature", "x", "  ")).toBe("feature: x");
  });

  test("supports every intake intent", () => {
    expect(composeTitle("bug", "x")).toBe("bug: x");
    expect(composeTitle("task", "x")).toBe("task: x");
    expect(composeTitle("feature", "x")).toBe("feature: x");
    expect(composeTitle("chore", "x")).toBe("chore: x");
    expect(composeTitle("spike", "x")).toBe("spike: x");
    expect(composeTitle("decision", "x")).toBe("decision: x");
  });
});

describe("composeTitle — prefix-aware idempotence (GH-1304)", () => {
  test("matching prefix is idempotent — single canonical prefix, no double", () => {
    expect(composeTitle("bug", "bug(bd): broken thing")).toBe("bug(bd): broken thing");
    expect(composeTitle("task", "task(prx): do it")).toBe("task(prx): do it");
    expect(composeTitle("feature", "feature(aws): rollout")).toBe("feature(aws): rollout");
    expect(composeTitle("chore", "chore(bd): consolidate")).toBe("chore(bd): consolidate");
    expect(composeTitle("spike", "spike(ci): explore")).toBe("spike(ci): explore");
    expect(composeTitle("decision", "decision(prx): pick approach")).toBe("decision(prx): pick approach");
  });

  test("matching bare prefix (no inner scope) is idempotent", () => {
    expect(composeTitle("bug", "bug: broken thing")).toBe("bug: broken thing");
    expect(composeTitle("task", "task: do it")).toBe("task: do it");
    expect(composeTitle("decision", "decision: pick approach")).toBe("decision: pick approach");
  });

  test("alias replace: feat → feature", () => {
    expect(composeTitle("feature", "feat(prx): new verb")).toBe("feature(prx): new verb");
    expect(composeTitle("feature", "feat: bare")).toBe("feature: bare");
  });

  test("alias replace: fix → bug", () => {
    expect(composeTitle("bug", "fix(intake): off-by-one")).toBe("bug(intake): off-by-one");
    expect(composeTitle("bug", "fix: bare")).toBe("bug: bare");
  });

  test("explicit --scope overrides the inner scope from the title", () => {
    expect(composeTitle("bug", "bug(old): broken thing", "new")).toBe(
      "bug(new): broken thing",
    );
    expect(composeTitle("feature", "feat(old): bar", "new")).toBe(
      "feature(new): bar",
    );
  });

  test("explicit --scope is added when title prefix has no inner scope", () => {
    expect(composeTitle("bug", "bug: broken thing", "intake")).toBe(
      "bug(intake): broken thing",
    );
  });

  test("plain title (no prefix) keeps the existing behavior", () => {
    expect(composeTitle("bug", "broken thing")).toBe("bug: broken thing");
    expect(composeTitle("task", "do it", "prx")).toBe("task(prx): do it");
  });
});

describe("composeTitle — prefix mismatch (GH-1304)", () => {
  test("disagreeing intake-type prefix throws IntakeTitleMismatchError", () => {
    expect(() => composeTitle("bug", "chore(bd): consolidate stuff")).toThrow(
      IntakeTitleMismatchError,
    );
    expect(() => composeTitle("task", "feature(prx): new verb")).toThrow(
      IntakeTitleMismatchError,
    );
    expect(() => composeTitle("decision", "spike(prx): explore")).toThrow(
      IntakeTitleMismatchError,
    );
    expect(() => composeTitle("task", "decision(prx): pick approach")).toThrow(
      IntakeTitleMismatchError,
    );
  });

  test("conv-commit prefix without intake-type mapping (docs/refactor/test) throws", () => {
    expect(() => composeTitle("task", "docs(README): update")).toThrow(
      IntakeTitleMismatchError,
    );
    expect(() => composeTitle("bug", "refactor(core): split module")).toThrow(
      IntakeTitleMismatchError,
    );
    expect(() => composeTitle("feature", "test(intake): add coverage")).toThrow(
      IntakeTitleMismatchError,
    );
  });

  test("error carries innerPrefix, flagType, and mappedType fields", () => {
    try {
      composeTitle("bug", "chore(bd): consolidate");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(IntakeTitleMismatchError);
      const e = err as IntakeTitleMismatchError;
      expect(e.innerPrefix).toBe("chore");
      expect(e.flagType).toBe("bug");
      expect(e.mappedType).toBe("chore");
      expect(e.message).toContain("chore");
      expect(e.message).toContain("bug");
    }
  });

  test("docs/refactor/test errors carry mappedType=null", () => {
    try {
      composeTitle("task", "docs(README): update");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(IntakeTitleMismatchError);
      const e = err as IntakeTitleMismatchError;
      expect(e.mappedType).toBeNull();
      expect(e.message).toContain("no intake-type mapping");
    }
  });

  test("alias mismatch: feat → feature, but flag says bug", () => {
    expect(() => composeTitle("bug", "feat(prx): new verb")).toThrow(
      IntakeTitleMismatchError,
    );
  });
});

describe("composeBody", () => {
  test("returns user body when no surfaced-from", () => {
    expect(composeBody({ surfacedFrom: null, userBody: "hello" })).toBe("hello");
  });

  test("prepends surfaced-from banner with blank-line separator", () => {
    expect(
      composeBody({ surfacedFrom: "GH-666", userBody: "user body content" }),
    ).toBe("_Surfaced from GH-666_\n\nuser body content");
  });

  test("emits banner alone when user body is empty", () => {
    expect(composeBody({ surfacedFrom: "GH-1", userBody: "" })).toBe(
      "_Surfaced from GH-1_",
    );
  });

  test("trims trailing whitespace from user body", () => {
    expect(
      composeBody({ surfacedFrom: "GH-1", userBody: "body\n\n\n" }),
    ).toBe("_Surfaced from GH-1_\n\nbody");
  });
});

describe("resolveSurfacedFrom", () => {
  test("returns canonical GH-N when branch matches", () => {
    expect(resolveSurfacedFrom("/any", () => "GH-666")).toBe("GH-666");
  });

  test("returns null when branch is not a GH-N name", () => {
    expect(resolveSurfacedFrom("/any", () => "main")).toBeNull();
    expect(resolveSurfacedFrom("/any", () => "feature/foo")).toBeNull();
  });

  test("returns null when branch detection fails", () => {
    expect(resolveSurfacedFrom("/any", () => null)).toBeNull();
  });
});

describe("resolveBody", () => {
  test("--body-stdin reads from stdin", () => {
    expect(
      resolveBody(
        { bodyStdin: true },
        { readStdin: () => "from stdin", readFile: () => "no" },
      ),
    ).toBe("from stdin");
  });

  test("bodyFile reads from disk", () => {
    expect(
      resolveBody(
        { bodyFile: "/tmp/x.md", bodyStdin: false },
        { readStdin: () => "no", readFile: (p) => `read:${p}` },
      ),
    ).toBe("read:/tmp/x.md");
  });

  test("--body @path is resolved as file read", () => {
    expect(
      resolveBody(
        { body: "@/tmp/y.md", bodyStdin: false },
        { readStdin: () => "no", readFile: (p) => `file:${p}` },
      ),
    ).toBe("file:/tmp/y.md");
  });

  test("--body literal string passes through", () => {
    expect(
      resolveBody(
        { body: "literal", bodyStdin: false },
        { readStdin: () => "no", readFile: () => "no" },
      ),
    ).toBe("literal");
  });

  test("returns empty string when no source provided", () => {
    expect(
      resolveBody(
        { bodyStdin: false },
        { readStdin: () => "no", readFile: () => "no" },
      ),
    ).toBe("");
  });
});

describe("runIntake — dry run", () => {
  test("does not invoke bd or publish, exits 0", () => {
    const bdCalls: unknown[] = [];
    const publishCalls: unknown[] = [];
    const logs: string[] = [];
    const exitCode = runIntake(
      makeOptions({
        type: "task",
        title: "x",
        scope: "prx",
        body: "body",
        dryRun: true,
      }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        execBd: ((opts: unknown) => {
          bdCalls.push(opts);
          return { exitCode: 0, stdout: "", stderr: "", policy: null };
        }) as never,
        publishOne: ((opts: unknown) => {
          publishCalls.push(opts);
          return {
            exitCode: 0,
            outcome: "noop",
            bdId: "x",
            render: { bdId: "x", repo: "", title: "", outcome: "noop", dryRun: true, exitCode: 0 },
          } as PublishCoreResult;
        }) as never,
        detectBranchName: () => "GH-666",
        cwd: () => "/repo",
      },
    );
    expect(exitCode).toBe(0);
    expect(bdCalls).toEqual([]);
    expect(publishCalls).toEqual([]);
    expect(logs[0]).toContain("dry-run");
    expect(logs[0]).toContain("task(prx): x");
    expect(logs[0]).toContain("Surfaced from GH-666");
    // GH-1607: dry-run preview renders the bd-create argv (not gh).
    expect(logs[0]).toContain("bd create");
    expect(logs[0]).toContain("--type task");
    expect(logs[0]).toContain("--title 'task(prx): x'");
    // GH-1305 / GH-1607: area::<scope> is folded into the projected labels;
    // the dry-run preview surfaces them on the `labels:` line.
    expect(logs[0]).toContain("area::prx");
    // No --to flag → bd-only; no publish step in the preview.
    expect(logs[0]).toContain("to:             (none — bd-only)");
    expect(logs[0]).not.toContain("prx beads publish");
  });

  test("--to gh adds a publish step to the dry-run preview", () => {
    const logs: string[] = [];
    runIntake(
      makeOptions({ type: "bug", title: "broken", to: "gh", dryRun: true }),
      { log: (l) => logs.push(l), error: () => undefined },
      { detectBranchName: () => "main", cwd: () => "/repo" },
    );
    expect(logs[0]).toContain("to:             gh");
    expect(logs[0]).toContain("prx beads publish");
  });

  test("plain dry-run shows '(none)' surfaced-from outside a GH-N worktree", () => {
    const logs: string[] = [];
    runIntake(
      makeOptions({ title: "x", dryRun: true }),
      { log: (l) => logs.push(l), error: () => undefined },
      { detectBranchName: () => "main", cwd: () => "/repo" },
    );
    expect(logs[0]).toContain("(none — not in a GH-N worktree)");
    expect(logs[0]).not.toContain("Surfaced from");
  });
});

// GH-1607 acceptance bullet: `prx intake bug --title …` (no flag) creates
// a bd record, surfaces bd-id, creates NO GitHub issue.
describe("runIntake — bd-first default (GH-1607)", () => {
  test("calls bd create once, no publishOne when --to omitted, prints bd-id", () => {
    const logs: string[] = [];
    const stub = makeBdCreateStub("ai-home-042");
    let publishCallCount = 0;
    const exitCode = runIntake(
      makeOptions({ type: "bug", title: "broken" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        execBd: stub.exec as never,
        publishOne: (() => {
          publishCallCount++;
          return {
            exitCode: 0,
            outcome: "created",
            bdId: "ai-home-042",
            render: {
              bdId: "ai-home-042",
              repo: "o/r",
              title: "x",
              outcome: "created",
              dryRun: false,
              exitCode: 0,
            },
          } as PublishCoreResult;
        }) as never,
        detectBranchName: () => "main",
        cwd: () => "/repo",
      },
    );
    expect(exitCode).toBe(0);
    expect(stub.invocations).toHaveLength(1);
    expect(stub.invocations[0]!.subcommand).toBe("create");
    expect(publishCallCount).toBe(0);
    expect(logs[0]).toBe("ai-home-042");
  });

  test("bd create receives --silent, --type, --title, planning role", () => {
    const stub = makeBdCreateStub();
    runIntake(
      makeOptions({ type: "spike", title: "explore" }),
      { log: () => undefined, error: () => undefined },
      {
        execBd: stub.exec as never,
        detectBranchName: () => "main",
        cwd: () => "/repo",
      },
    );
    expect(stub.invocations[0]!.args).toEqual(["--silent", "--type", "task", "--title", "spike: explore"]);
    expect(stub.invocations[0]!.state).toBe("planning");
    expect(stub.invocations[0]!.role).toBe("planner");
  });
});

// GH-1607 acceptance bullet: `prx intake bug --title … --to gh` creates a
// bd record + a GH issue and populates external_ref via publishOne.
describe("runIntake — --to gh projection (GH-1607)", () => {
  test("calls bd create then publishOne with the new bd id", () => {
    const logs: string[] = [];
    const stub = makeBdCreateStub("ai-home-007");
    const publishCalls: BeadsPublishOptions[] = [];
    const exitCode = runIntake(
      makeOptions({ type: "bug", title: "broken", to: "gh", repo: "owner/repo" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        execBd: stub.exec as never,
        publishOne: ((opts: BeadsPublishOptions, _deps: BeadsPublishDeps) => {
          publishCalls.push(opts);
          return {
            exitCode: 0,
            outcome: "created",
            bdId: opts.bdId,
            externalRef: "https://github.com/owner/repo/issues/9",
            render: {
              bdId: opts.bdId,
              repo: "owner/repo",
              title: "broken",
              outcome: "created",
              externalRef: "https://github.com/owner/repo/issues/9",
              dryRun: false,
              exitCode: 0,
            },
          } as PublishCoreResult;
        }) as never,
        detectBranchName: () => "main",
        cwd: () => "/repo",
      },
    );
    expect(exitCode).toBe(0);
    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0]!.bdId).toBe("ai-home-007");
    expect(publishCalls[0]!.repo).toBe("owner/repo");
    // Type label is folded through extraLabels so the adapter mirrors it.
    expect(publishCalls[0]!.extraLabels).toContain("type::bug");
    // bd-id (primary handle) + GH URL on a follow-up line.
    expect(logs[0]).toBe("ai-home-007\nhttps://github.com/owner/repo/issues/9");
  });

  test("spike intent passes type::task + type::spike through extraLabels", () => {
    const stub = makeBdCreateStub();
    const publishCalls: BeadsPublishOptions[] = [];
    runIntake(
      makeOptions({ type: "spike", title: "explore", to: "gh" }),
      { log: () => undefined, error: () => undefined },
      {
        execBd: stub.exec as never,
        publishOne: ((opts: BeadsPublishOptions) => {
          publishCalls.push(opts);
          return {
            exitCode: 0,
            outcome: "created",
            bdId: opts.bdId,
            externalRef: "https://x/y/issues/1",
            render: { bdId: opts.bdId, repo: "", title: "", outcome: "created", externalRef: "https://x/y/issues/1", dryRun: false, exitCode: 0 },
          } as PublishCoreResult;
        }) as never,
        detectBranchName: () => "main",
        cwd: () => "/repo",
      },
    );
    expect(publishCalls[0]!.extraLabels).toContain("type::task");
    expect(publishCalls[0]!.extraLabels).toContain("type::spike");
  });

  test("decision intent passes type::task + type::decision through extraLabels", () => {
    const stub = makeBdCreateStub();
    const publishCalls: BeadsPublishOptions[] = [];
    runIntake(
      makeOptions({ type: "decision", title: "design X", to: "gh" }),
      { log: () => undefined, error: () => undefined },
      {
        execBd: stub.exec as never,
        publishOne: ((opts: BeadsPublishOptions) => {
          publishCalls.push(opts);
          return {
            exitCode: 0,
            outcome: "created",
            bdId: opts.bdId,
            externalRef: "https://x/y/issues/1",
            render: { bdId: opts.bdId, repo: "", title: "", outcome: "created", externalRef: "https://x/y/issues/1", dryRun: false, exitCode: 0 },
          } as PublishCoreResult;
        }) as never,
        detectBranchName: () => "main",
        cwd: () => "/repo",
      },
    );
    expect(publishCalls[0]!.extraLabels).toContain("type::task");
    expect(publishCalls[0]!.extraLabels).toContain("type::decision");
  });

  test("idempotent retry: publishOne's noop path is surfaced cleanly", () => {
    // Simulates `prx beads publish` finding an existing external_ref on the
    // bd record (step 6 in publish.ts) — no GH create, no duplicate issue.
    const stub = makeBdCreateStub("ai-home-099");
    const logs: string[] = [];
    runIntake(
      makeOptions({ type: "task", title: "already linked", to: "gh" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        execBd: stub.exec as never,
        publishOne: (() => ({
          exitCode: 0,
          outcome: "noop",
          bdId: "ai-home-099",
          externalRef: "https://github.com/o/r/issues/5",
          render: {
            bdId: "ai-home-099",
            repo: "o/r",
            title: "already linked",
            outcome: "noop",
            externalRef: "https://github.com/o/r/issues/5",
            dryRun: false,
            exitCode: 0,
            message: "already published to GH-5",
          },
        })) as never,
        detectBranchName: () => "main",
        cwd: () => "/repo",
      },
    );
    expect(logs[0]).toBe("ai-home-099\nhttps://github.com/o/r/issues/5");
  });

  test("bd create failure short-circuits before publishOne", () => {
    let publishCallCount = 0;
    const errors: string[] = [];
    const exitCode = runIntake(
      makeOptions({ type: "task", title: "x", to: "gh" }),
      { log: () => undefined, error: (l) => errors.push(l) },
      {
        execBd: (() => ({
          exitCode: 1,
          stdout: "",
          stderr: "bd: out of space\n",
          policy: null,
        })) as never,
        publishOne: (() => {
          publishCallCount++;
          return { exitCode: 0, outcome: "noop", bdId: "x", render: { bdId: "x", repo: "", title: "", outcome: "noop", dryRun: false, exitCode: 0 } } as PublishCoreResult;
        }) as never,
        detectBranchName: () => "main",
        cwd: () => "/repo",
      },
    );
    expect(exitCode).toBe(1);
    expect(publishCallCount).toBe(0);
    expect(errors.join("\n")).toContain("bd: out of space");
  });

  test("publishOne failure surfaces error but bd-id stays primary handle", () => {
    const errors: string[] = [];
    const logs: string[] = [];
    const exitCode = runIntake(
      makeOptions({ type: "task", title: "x", to: "gh" }),
      { log: (l) => logs.push(l), error: (l) => errors.push(l) },
      {
        execBd: makeBdCreateStub("ai-home-bad").exec as never,
        publishOne: (() => ({
          exitCode: 1,
          outcome: "error",
          bdId: "ai-home-bad",
          render: {
            bdId: "ai-home-bad",
            repo: "o/r",
            title: "x",
            outcome: "error",
            dryRun: false,
            exitCode: 1,
            message: "prx beads publish: gh: auth required",
          },
        })) as never,
        detectBranchName: () => "main",
        cwd: () => "/repo",
      },
    );
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("auth required");
  });
});

describe("composeStructuredBody", () => {
  test("description-only emits a single section", () => {
    expect(composeStructuredBody({ description: "what" })).toBe(
      "## Description\n\nwhat",
    );
  });

  test("design-only emits a single section", () => {
    expect(composeStructuredBody({ design: "how" })).toBe(
      "## Design\n\nhow",
    );
  });

  test("acceptance-only emits Acceptance Criteria heading", () => {
    expect(composeStructuredBody({ acceptance: "done when X" })).toBe(
      "## Acceptance Criteria\n\ndone when X",
    );
  });

  test("notes-only emits a single section", () => {
    expect(composeStructuredBody({ notes: "see Y" })).toBe(
      "## Notes\n\nsee Y",
    );
  });

  test("all four fields render in fixed order with blank-line separators", () => {
    expect(
      composeStructuredBody({
        description: "what",
        design: "how",
        acceptance: "done when X",
        notes: "see Y",
      }),
    ).toBe(
      "## Description\n\nwhat\n\n## Design\n\nhow\n\n## Acceptance Criteria\n\ndone when X\n\n## Notes\n\nsee Y",
    );
  });

  test("empty input returns empty string", () => {
    expect(composeStructuredBody({})).toBe("");
  });

  test("empty-string fields are treated as absent", () => {
    expect(
      composeStructuredBody({ description: "what", design: "", acceptance: "", notes: "" }),
    ).toBe("## Description\n\nwhat");
  });

  test("composeBody wraps structured output with surfaced-from banner", () => {
    const structured = composeStructuredBody({ description: "what" });
    expect(composeBody({ surfacedFrom: "GH-1247", userBody: structured })).toBe(
      "_Surfaced from GH-1247_\n\n## Description\n\nwhat",
    );
  });
});

describe("intakeOptionsSchema — structured/freeform mutex", () => {
  const base = {
    type: "feature" as const,
    title: "x",
    bodyStdin: false,
    labels: [] as string[],
    assignees: [] as string[],
    dryRun: false,
    format: "plain" as const,
  };

  test("structured fields alone parse cleanly", () => {
    const result = intakeOptionsSchema.safeParse({
      ...base,
      description: "what",
      design: "how",
      acceptance: "done",
      notes: "y",
    });
    expect(result.success).toBe(true);
  });

  test("--body alone still parses cleanly", () => {
    const result = intakeOptionsSchema.safeParse({ ...base, body: "blob" });
    expect(result.success).toBe(true);
  });

  test("structured + --body rejects", () => {
    const result = intakeOptionsSchema.safeParse({
      ...base,
      body: "blob",
      description: "what",
    });
    expect(result.success).toBe(false);
  });

  test("structured + --body-file rejects", () => {
    const result = intakeOptionsSchema.safeParse({
      ...base,
      bodyFile: "/tmp/x.md",
      design: "how",
    });
    expect(result.success).toBe(false);
  });

  test("structured + --body-stdin rejects", () => {
    const result = intakeOptionsSchema.safeParse({
      ...base,
      bodyStdin: true,
      acceptance: "done",
    });
    expect(result.success).toBe(false);
  });

  test("all empty (no body, no structured) still parses — matches existing behavior", () => {
    const result = intakeOptionsSchema.safeParse(base);
    expect(result.success).toBe(true);
  });

  test("--description '' (empty string) is not treated as structured-mode", () => {
    const result = intakeOptionsSchema.safeParse({
      ...base,
      body: "blob",
      description: "",
    });
    expect(result.success).toBe(true);
  });
});

describe("runIntake — structured fields", () => {
  test("dry-run emits labeled-section body in the bd-create argv", () => {
    const logs: string[] = [];
    runIntake(
      makeOptions({
        type: "feature",
        title: "structured fields",
        description: "what",
        design: "how",
        acceptance: "done when X",
        notes: "see Y",
        dryRun: true,
      }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        execBd: (() => ({ exitCode: 0, stdout: "", stderr: "", policy: null })) as never,
        detectBranchName: () => "main",
        cwd: () => "/repo",
      },
    );
    // GH-1607: bd-create's --description carries the composed body (the
    // surfaced-from banner is absent on `main`, so it's just the structured
    // sections). publishOne mirrors that body onto GH on --to gh.
    expect(logs[0]).toContain(
      "--description '## Description\n\nwhat\n\n## Design\n\nhow\n\n## Acceptance Criteria\n\ndone when X\n\n## Notes\n\nsee Y'",
    );
  });

  test("structured fields are written to bd via --description on create", () => {
    const stub = makeBdCreateStub("ai-home-abc");
    runIntake(
      makeOptions({
        type: "feature",
        title: "x",
        description: "what",
        design: "how",
        acceptance: "done",
        notes: "y",
      }),
      { log: () => undefined, error: () => undefined },
      {
        execBd: stub.exec as never,
        detectBranchName: () => "main",
        cwd: () => "/repo",
      },
    );
    expect(stub.invocations).toHaveLength(1);
    expect(stub.invocations[0]!.subcommand).toBe("create");
    const descIdx = stub.invocations[0]!.args.indexOf("--description");
    expect(descIdx).toBeGreaterThanOrEqual(0);
    const body = stub.invocations[0]!.args[descIdx + 1]!;
    expect(body).toContain("## Description\n\nwhat");
    expect(body).toContain("## Design\n\nhow");
    expect(body).toContain("## Acceptance Criteria\n\ndone");
    expect(body).toContain("## Notes\n\ny");
  });
});

describe("runIntake — title prefix mismatch (GH-1304)", () => {
  test("aborts with non-zero exit, no bd calls, stderr message", () => {
    let bdCallCount = 0;
    const errors: string[] = [];
    const logs: string[] = [];
    const exitCode = runIntake(
      makeOptions({ type: "bug", title: "chore(bd): consolidate stuff" }),
      { log: (l) => logs.push(l), error: (l) => errors.push(l) },
      {
        execBd: (() => {
          bdCallCount++;
          return { exitCode: 0, stdout: "", stderr: "", policy: null } as BdExecResult;
        }) as never,
        detectBranchName: () => "main",
        cwd: () => "/repo",
      },
    );
    expect(exitCode).not.toBe(0);
    expect(bdCallCount).toBe(0);
    expect(logs).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("chore");
    expect(errors[0]).toContain("bug");
    // Remediation hint surfaces the mapped intake type.
    expect(errors[0]).toContain("prx intake chore");
  });

  test("docs prefix surfaces 'no intake-type mapping' message", () => {
    const errors: string[] = [];
    const exitCode = runIntake(
      makeOptions({ type: "task", title: "docs(README): update" }),
      { log: () => undefined, error: (l) => errors.push(l) },
      { detectBranchName: () => "main", cwd: () => "/repo" },
    );
    expect(exitCode).not.toBe(0);
    expect(errors[0]).toContain("no intake-type mapping");
  });

  test("aborts even in dry-run before printing the preview", () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const exitCode = runIntake(
      makeOptions({
        type: "bug",
        title: "chore(bd): consolidate",
        dryRun: true,
      }),
      { log: (l) => logs.push(l), error: (l) => errors.push(l) },
      { detectBranchName: () => "main", cwd: () => "/repo" },
    );
    expect(exitCode).not.toBe(0);
    expect(logs).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  test("matching prefix passes through cleanly in dry-run (no double-prefix)", () => {
    const logs: string[] = [];
    runIntake(
      makeOptions({
        type: "bug",
        title: "bug(bd): broken thing",
        dryRun: true,
      }),
      { log: (l) => logs.push(l), error: () => undefined },
      { detectBranchName: () => "main", cwd: () => "/repo" },
    );
    expect(logs[0]).toContain("title:          bug(bd): broken thing");
    expect(logs[0]).not.toContain("bug(bd): bug(bd):");
  });
});

// GH-1607: with the actor inverted, the gh-side failure surface lives in
// `publishOne`. This case asserts that when --to gh's projection fails,
// runIntake propagates its exit code (the bd record still exists).
describe("runIntake — --to gh projection failure", () => {
  test("propagates publishOne exit code; bd-create still ran", () => {
    const stub = makeBdCreateStub("ai-home-001");
    const exitCode = runIntake(
      makeOptions({ type: "task", title: "x", to: "gh" }),
      { log: () => undefined, error: () => undefined },
      {
        execBd: stub.exec as never,
        publishOne: (() => ({
          exitCode: 2,
          outcome: "error",
          bdId: "ai-home-001",
          render: {
            bdId: "ai-home-001",
            repo: "",
            title: "",
            outcome: "error",
            dryRun: false,
            exitCode: 2,
            message: "prx beads publish: gh: auth required",
          },
        })) as never,
        detectBranchName: () => "main",
        cwd: () => "/repo",
      },
    );
    expect(exitCode).toBe(2);
    // bd-create ran first; only the GH projection failed.
    expect(stub.invocations).toHaveLength(1);
    expect(stub.invocations[0]!.subcommand).toBe("create");
  });
});

// GH-1486 / GH-1607: TTY-gated confirm prompt — operator-protection guard
// around any side-effecting write (now bd-first; the confirm wraps both the
// bd-create and optional --to gh projection). Defaults to commit-by-default
// for non-TTY (scripts/CI), requires y/N at a TTY, and `--yes` bypasses the
// prompt. `--dry-run` always wins (no write, no prompt).
describe("runIntake — TTY confirm (GH-1486, GH-1607)", () => {
  test("TTY + confirm 'yes' → bd called, exit 0", () => {
    const stub = makeBdCreateStub();
    let confirmCallCount = 0;
    const exitCode = runIntake(
      makeOptions({ type: "spike", title: "probe" }),
      { log: () => undefined, error: () => undefined },
      {
        execBd: stub.exec as never,
        detectBranchName: () => "main",
        cwd: () => "/repo",
        isStdinTTY: () => true,
        isStdoutTTY: () => true,
        confirmIntake: () => {
          confirmCallCount++;
          return true;
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(stub.invocations).toHaveLength(1);
    expect(confirmCallCount).toBe(1);
  });

  test("TTY + confirm 'no' → bd NOT called, exit 1, stderr explains abort", () => {
    const stub = makeBdCreateStub();
    const errors: string[] = [];
    const exitCode = runIntake(
      makeOptions({ type: "spike", title: "probe" }),
      { log: () => undefined, error: (line) => errors.push(line) },
      {
        execBd: stub.exec as never,
        detectBranchName: () => "main",
        cwd: () => "/repo",
        isStdinTTY: () => true,
        isStdoutTTY: () => true,
        confirmIntake: () => false,
      },
    );
    expect(exitCode).toBe(1);
    expect(stub.invocations).toEqual([]);
    expect(errors.join("\n")).toContain("aborted by operator");
    expect(errors.join("\n")).toContain("no record written");
  });

  test("TTY + --yes → confirm NOT called, bd called once", () => {
    const stub = makeBdCreateStub();
    let confirmCallCount = 0;
    const exitCode = runIntake(
      makeOptions({ type: "spike", title: "probe", yes: true }),
      { log: () => undefined, error: () => undefined },
      {
        execBd: stub.exec as never,
        detectBranchName: () => "main",
        cwd: () => "/repo",
        isStdinTTY: () => true,
        isStdoutTTY: () => true,
        confirmIntake: () => {
          confirmCallCount++;
          return true;
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(stub.invocations).toHaveLength(1);
    expect(confirmCallCount).toBe(0);
  });

  test("non-TTY stdin → confirm NOT called, bd called once (preserves CI/script behavior)", () => {
    const stub = makeBdCreateStub();
    let confirmCallCount = 0;
    const exitCode = runIntake(
      makeOptions({ type: "spike", title: "probe" }),
      { log: () => undefined, error: () => undefined },
      {
        execBd: stub.exec as never,
        detectBranchName: () => "main",
        cwd: () => "/repo",
        isStdinTTY: () => false,
        isStdoutTTY: () => true,
        confirmIntake: () => {
          confirmCallCount++;
          return true;
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(stub.invocations).toHaveLength(1);
    expect(confirmCallCount).toBe(0);
  });

  test("non-TTY stdout (redirected) → confirm NOT called, bd called once", () => {
    const stub = makeBdCreateStub();
    let confirmCallCount = 0;
    const exitCode = runIntake(
      makeOptions({ type: "spike", title: "probe" }),
      { log: () => undefined, error: () => undefined },
      {
        execBd: stub.exec as never,
        detectBranchName: () => "main",
        cwd: () => "/repo",
        isStdinTTY: () => true,
        isStdoutTTY: () => false,
        confirmIntake: () => {
          confirmCallCount++;
          return true;
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(stub.invocations).toHaveLength(1);
    expect(confirmCallCount).toBe(0);
  });

  test("dry-run wins: TTY + dryRun → confirm NOT called, bd NOT called", () => {
    const stub = makeBdCreateStub();
    let confirmCallCount = 0;
    const exitCode = runIntake(
      makeOptions({ type: "spike", title: "probe", dryRun: true }),
      { log: () => undefined, error: () => undefined },
      {
        execBd: stub.exec as never,
        detectBranchName: () => "main",
        cwd: () => "/repo",
        isStdinTTY: () => true,
        isStdoutTTY: () => true,
        confirmIntake: () => {
          confirmCallCount++;
          return true;
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(stub.invocations).toEqual([]);
    expect(confirmCallCount).toBe(0);
  });

  test("dry-run wins over --yes: dryRun + yes → no bd call, no prompt", () => {
    const stub = makeBdCreateStub();
    let confirmCallCount = 0;
    const exitCode = runIntake(
      makeOptions({ type: "spike", title: "probe", dryRun: true, yes: true }),
      { log: () => undefined, error: () => undefined },
      {
        execBd: stub.exec as never,
        detectBranchName: () => "main",
        cwd: () => "/repo",
        isStdinTTY: () => true,
        isStdoutTTY: () => true,
        confirmIntake: () => {
          confirmCallCount++;
          return true;
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(stub.invocations).toEqual([]);
    expect(confirmCallCount).toBe(0);
  });

  test("default confirm sees the bd-first preview headline (not 'prx intake (dry-run)')", () => {
    const stub = makeBdCreateStub();
    let capturedPreview = "";
    runIntake(
      makeOptions({ type: "spike", title: "probe" }),
      { log: () => undefined, error: () => undefined },
      {
        execBd: stub.exec as never,
        detectBranchName: () => "main",
        cwd: () => "/repo",
        isStdinTTY: () => true,
        isStdoutTTY: () => true,
        confirmIntake: (preview) => {
          capturedPreview = preview;
          return true;
        },
      },
    );
    // The default-confirm wrapper is what swaps the `prx intake (dry-run)`
    // headline for `Will file:` before printing — the raw preview passed to
    // the callback retains it.
    expect(capturedPreview).toContain("prx intake (dry-run)");
    expect(capturedPreview).toContain("title:          spike: probe");
    expect(capturedPreview).toContain("would run:");
    expect(capturedPreview).toContain("bd create");
  });
});

// GH-1305: --scope is bound to the canonical AREA Zod enum and auto-applies
// `area::<scope>` to the gh label set.
describe("intakeOptionsSchema — scope validation (GH-1305)", () => {
  const base = {
    type: "bug" as const,
    title: "x",
    bodyStdin: false,
    labels: [] as string[],
    assignees: [] as string[],
    dryRun: false,
    format: "plain" as const,
  };

  test("rejects unknown scope and reports the valid AREA set", () => {
    const result = intakeOptionsSchema.safeParse({ ...base, scope: "bd" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = JSON.stringify(result.error.issues);
      // ZodError lists the enum options on rejection — operator gets a
      // straight valid-scope set in the failure path.
      expect(message).toContain("beads");
      expect(message).toContain("prx");
    }
  });

  test("accepts a canonical AREA value", () => {
    const result = intakeOptionsSchema.safeParse({ ...base, scope: "beads" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scope).toBe("beads");
    }
  });
});

// GH-1258: per-type required-field validation through the full
// intakeOptionsSchema parse. Fires only when at least one structured
// field is present (--description/--design/--acceptance/--notes); the
// freeform `--body` cluster and bare-title intake stay permissive.
describe("intakeOptionsSchema — per-type required-field validation (GH-1258)", () => {
  const base = {
    title: "probe",
    bodyStdin: false,
    labels: [] as string[],
    assignees: [] as string[],
    dryRun: false,
    format: "plain" as const,
  };

  test("task: description without acceptance fails with acceptance-shaped issue", () => {
    const result = intakeOptionsSchema.safeParse({
      ...base,
      type: "task",
      description: "x",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("acceptance");
      const msg = result.error.issues.find((i) => i.path[0] === "acceptance")!
        .message;
      expect(msg).toBe("acceptance: required");
    }
  });

  test("task: description + acceptance passes", () => {
    const result = intakeOptionsSchema.safeParse({
      ...base,
      type: "task",
      description: "x",
      acceptance: "y",
    });
    expect(result.success).toBe(true);
  });

  test("bug: description-only fails (acceptance required)", () => {
    const result = intakeOptionsSchema.safeParse({
      ...base,
      type: "bug",
      description: "x",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("acceptance");
    }
  });

  test("feature: description + acceptance passes (design/notes optional)", () => {
    const result = intakeOptionsSchema.safeParse({
      ...base,
      type: "feature",
      description: "x",
      acceptance: "y",
    });
    expect(result.success).toBe(true);
  });

  test("chore: acceptance without description fails (description required)", () => {
    const result = intakeOptionsSchema.safeParse({
      ...base,
      type: "chore",
      acceptance: "y",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("description");
    }
  });

  test("spike: enforcement is deferred — description-only passes today", () => {
    const result = intakeOptionsSchema.safeParse({
      ...base,
      type: "spike",
      description: "x",
    });
    expect(result.success).toBe(true);
  });

  test("freeform --body bypasses per-type validation (back-compat)", () => {
    const result = intakeOptionsSchema.safeParse({
      ...base,
      type: "task",
      body: "free text",
    });
    expect(result.success).toBe(true);
  });

  test("bare title (no body, no structured) stays permissive (back-compat)", () => {
    const result = intakeOptionsSchema.safeParse({ ...base, type: "task" });
    expect(result.success).toBe(true);
  });
});

// GH-1489 / GH-1607: intake stamps `type::<bd_type>` so the type-pass
// classifier's `hasType` gate (GH-957) preserves it on subsequent runs. After
// the bd-first flip, the type label reaches GH via `publishOne`'s extraLabels;
// for the bd-only default it lives only in the projected label set (visible in
// `IntakeResult.labels`).
//
// Helper: capture labels passed to publishOne by --to gh runs.
function capturePublishLabels(
  options: IntakeOptions,
  deps: Partial<Parameters<typeof runIntake>[2]> = {},
): string[] {
  let captured: string[] | null = null;
  const stub = makeBdCreateStub();
  runIntake(
    options,
    { log: () => undefined, error: () => undefined },
    {
      execBd: stub.exec as never,
      publishOne: ((opts: BeadsPublishOptions) => {
        captured = [...opts.extraLabels];
        return {
          exitCode: 0,
          outcome: "created",
          bdId: opts.bdId,
          externalRef: "https://x/y/issues/1",
          render: { bdId: opts.bdId, repo: "", title: "", outcome: "created", externalRef: "https://x/y/issues/1", dryRun: false, exitCode: 0 },
        } as PublishCoreResult;
      }) as never,
      detectBranchName: () => "main",
      cwd: () => "/repo",
      ...deps,
    },
  );
  return captured ?? [];
}

describe("runIntake — type-label stamping (GH-1489)", () => {
  test("task intent projects type::task through publishOne extraLabels", () => {
    const labels = capturePublishLabels(makeOptions({ type: "task", title: "wire up X", to: "gh" }));
    expect(labels).toContain("type::task");
    // Bd-axis type only; no spike marker for plain task intent.
    expect(labels).not.toContain("type::spike");
  });

  test("spike intent projects both type::task and type::spike (bd-axis + GH-only)", () => {
    const labels = capturePublishLabels(makeOptions({ type: "spike", title: "explore caching", to: "gh" }));
    expect(labels).toContain("type::task");
    expect(labels).toContain("type::spike");
  });

  test("spike intent + scope folds in area::<scope> alongside both type labels", () => {
    const labels = capturePublishLabels(makeOptions({ type: "spike", title: "explore caching", scope: "prx", to: "gh" }));
    expect(labels).toContain("type::task");
    expect(labels).toContain("type::spike");
    expect(labels).toContain("area::prx");
  });

  test("composeTitle('spike', 'task(prx): X') is a prefix mismatch", () => {
    expect(() => composeTitle("spike", "task(prx): explore")).toThrow(
      IntakeTitleMismatchError,
    );
    try {
      composeTitle("spike", "task(prx): explore");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(IntakeTitleMismatchError);
      const e = err as IntakeTitleMismatchError;
      expect(e.innerPrefix).toBe("task");
      expect(e.flagType).toBe("spike");
      expect(e.mappedType).toBe("task");
    }
  });
});

describe("runIntake — area-label folding (GH-1305)", () => {
  test("auto-applies area::<scope> when scope is set and no other labels", () => {
    const labels = capturePublishLabels(makeOptions({ type: "bug", title: "x", scope: "beads", to: "gh" }));
    expect(labels).toContain("area::beads");
    // GH-1489: bd-axis type label is also stamped at creation.
    expect(labels).toContain("type::bug");
  });

  test("dedupes when --label area::<scope> is also passed explicitly", () => {
    const labels = capturePublishLabels(
      makeOptions({
        type: "bug",
        title: "x",
        scope: "beads",
        labels: ["area::beads", "priority::high"],
        to: "gh",
      }),
    );
    // area::beads appears exactly once; priority::high preserved.
    expect(labels.filter((l) => l === "area::beads")).toHaveLength(1);
    expect(labels).toContain("priority::high");
  });

  test("no scope ⇒ operator labels pass through alongside the bd-axis stamp", () => {
    const labels = capturePublishLabels(
      makeOptions({ type: "bug", title: "x", labels: ["priority::high"], to: "gh" }),
    );
    expect(labels).toContain("priority::high");
    // GH-1489: bd-axis type label is always stamped, even without --scope.
    expect(labels).toContain("type::bug");
    // No area::* without --scope.
    expect(labels.some((l) => l.startsWith("area::"))).toBe(false);
  });
});

// GH-1520: --scope auto-defaults to an inferred AREA when omitted and cwd
// maps to a known path prefix inside a GH-linked worktree. Explicit --scope
// always wins; no inference on non-GH branches (main, feature/foo, etc.).
describe("inferScope — unit (GH-1520)", () => {
  test("returns undefined when branch is null or non-GH-linked", () => {
    expect(inferScope(null, "/repo/src/beads", "/repo")).toBeUndefined();
    expect(inferScope("main", "/repo/src/beads", "/repo")).toBeUndefined();
    expect(inferScope("feature/foo", "/repo/src/beads", "/repo")).toBeUndefined();
  });

  test("returns undefined when repoRoot is null (git lookup failed)", () => {
    expect(inferScope("GH-123", "/repo/src/beads", null)).toBeUndefined();
  });

  test("GH-N-descriptor branches (e.g. GH-1520-intake-scope-default) are GH-linked", () => {
    expect(inferScope("GH-1520-intake-scope-default", "/repo/src/intake", "/repo")).toBe("prx");
  });

  test("repo root with known repo name: ai-home → prx", () => {
    expect(inferScope("GH-123", "/home/user/ai-home", "/home/user/ai-home")).toBe("prx");
  });

  test("repo root with unknown repo name returns undefined", () => {
    expect(inferScope("GH-123", "/repo", "/repo")).toBeUndefined();
  });

  test("maps src/beads → beads", () => {
    expect(inferScope("GH-123", "/repo/src/beads", "/repo")).toBe("beads");
    expect(inferScope("GH-123", "/repo/src/beads/some/sub", "/repo")).toBe("beads");
  });

  test("maps src/claude → claude-code", () => {
    expect(inferScope("GH-123", "/repo/src/claude", "/repo")).toBe("claude-code");
  });

  test("maps packages/prx-mux → tmux", () => {
    expect(inferScope("GH-123", "/repo/packages/prx-mux", "/repo")).toBe("tmux");
  });

  test("maps nix → home-manager", () => {
    expect(inferScope("GH-123", "/repo/nix", "/repo")).toBe("home-manager");
  });

  test("maps .github → ci", () => {
    expect(inferScope("GH-123", "/repo/.github/workflows", "/repo")).toBe("ci");
  });

  test("maps src/* catch-all → prx", () => {
    expect(inferScope("GH-123", "/repo/src/pr-state", "/repo")).toBe("prx");
    expect(inferScope("GH-123", "/repo/src/intake", "/repo")).toBe("prx");
    expect(inferScope("GH-123", "/repo/src/triage", "/repo")).toBe("prx");
  });

  test("returns undefined for unrecognised root-level dir", () => {
    expect(inferScope("GH-123", "/repo/codex", "/repo")).toBeUndefined();
  });
});

describe("runIntake — scope inference (GH-1520)", () => {
  test("explicit --scope wins over inferred scope", () => {
    const labels = capturePublishLabels(
      makeOptions({ type: "bug", title: "x", scope: "ci", to: "gh" }),
      {
        detectBranchName: () => "GH-123",
        cwd: () => "/repo/src/beads",
        getRepoRoot: () => "/repo",
      },
    );
    expect(labels).toContain("area::ci");
    expect(labels).not.toContain("area::beads");
  });

  test("inferred scope used when --scope omitted in GH-N worktree", () => {
    const logs: string[] = [];
    runIntake(
      makeOptions({ type: "bug", title: "x", dryRun: true }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        detectBranchName: () => "GH-123",
        cwd: () => "/repo/src/beads",
        getRepoRoot: () => "/repo",
      },
    );
    expect(logs[0]).toContain("area::beads");
    expect(logs[0]).toContain("bug(beads): x");
  });

  test("no scope inferred outside a GH-N worktree", () => {
    const logs: string[] = [];
    runIntake(
      makeOptions({ type: "bug", title: "x", dryRun: true }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        detectBranchName: () => "main",
        cwd: () => "/repo/src/beads",
        getRepoRoot: () => "/repo",
      },
    );
    expect(logs[0]).not.toContain("area::");
  });
});
