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

// Helper: stub the `run` command runner for the `gh issue create` write
// (GH-1011: beads retired, GitHub is the write plane). Records each gh
// invocation and returns the new issue URL on stdout so runIntake can parse
// it. Returns a fresh stub per test. `issueNumber` is configurable (default
// 42); `owner/repo` in the URL is fixed to bounded-systems/prx.
function makeGhCreateStub(issueNumber = 42): {
  invocations: string[][];
  issueUrl: string;
  run: (
    cmd: string[],
    o?: { check?: boolean },
  ) => { status: number; stdout: string; stderr: string };
} {
  const invocations: string[][] = [];
  const issueUrl = `https://github.com/bounded-systems/prx/issues/${issueNumber}`;
  return {
    invocations,
    issueUrl,
    run: (cmd: string[]) => {
      invocations.push(cmd);
      // Only `gh issue create` is expected on this path.
      return { status: 0, stdout: `${issueUrl}\n`, stderr: "" };
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
    expect(composeTitle("decision", "decision(prx): pick approach")).toBe(
      "decision(prx): pick approach",
    );
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
    expect(composeTitle("bug", "bug(old): broken thing", "new")).toBe("bug(new): broken thing");
    expect(composeTitle("feature", "feat(old): bar", "new")).toBe("feature(new): bar");
  });

  test("explicit --scope is added when title prefix has no inner scope", () => {
    expect(composeTitle("bug", "bug: broken thing", "intake")).toBe("bug(intake): broken thing");
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
    expect(() => composeTitle("task", "feature(prx): new verb")).toThrow(IntakeTitleMismatchError);
    expect(() => composeTitle("decision", "spike(prx): explore")).toThrow(IntakeTitleMismatchError);
    expect(() => composeTitle("task", "decision(prx): pick approach")).toThrow(
      IntakeTitleMismatchError,
    );
  });

  test("conv-commit prefix without intake-type mapping (docs/refactor/test) throws", () => {
    expect(() => composeTitle("task", "docs(README): update")).toThrow(IntakeTitleMismatchError);
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
    expect(() => composeTitle("bug", "feat(prx): new verb")).toThrow(IntakeTitleMismatchError);
  });
});

describe("composeBody", () => {
  test("returns user body when no surfaced-from", () => {
    expect(composeBody({ surfacedFrom: null, userBody: "hello" })).toBe("hello");
  });

  test("prepends surfaced-from banner with blank-line separator", () => {
    expect(composeBody({ surfacedFrom: "GH-666", userBody: "user body content" })).toBe(
      "_Surfaced from GH-666_\n\nuser body content",
    );
  });

  test("emits banner alone when user body is empty", () => {
    expect(composeBody({ surfacedFrom: "GH-1", userBody: "" })).toBe("_Surfaced from GH-1_");
  });

  test("trims trailing whitespace from user body", () => {
    expect(composeBody({ surfacedFrom: "GH-1", userBody: "body\n\n\n" })).toBe(
      "_Surfaced from GH-1_\n\nbody",
    );
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
      resolveBody({ bodyStdin: true }, { readStdin: () => "from stdin", readFile: () => "no" }),
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
    expect(resolveBody({ bodyStdin: false }, { readStdin: () => "no", readFile: () => "no" })).toBe(
      "",
    );
  });
});

describe("runIntake — dry run", () => {
  test("does not invoke gh, exits 0, renders the gh issue create preview", () => {
    const stub = makeGhCreateStub();
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
        run: stub.run as never,
        detectBranchName: () => "GH-666",
        cwd: () => "/repo",
      },
    );
    expect(exitCode).toBe(0);
    // Dry-run performs no write.
    expect(stub.invocations).toEqual([]);
    expect(logs[0]).toContain("dry-run");
    expect(logs[0]).toContain("task(prx): x");
    expect(logs[0]).toContain("Surfaced from GH-666");
    // GH-1011: dry-run preview renders the gh issue create argv.
    expect(logs[0]).toContain("would run:");
    expect(logs[0]).toContain("gh issue create");
    expect(logs[0]).toContain("--title 'task(prx): x'");
    // GH-1305: area::<scope> is folded into the labels and reaches gh as a
    // repeated --label flag.
    expect(logs[0]).toContain("area::prx");
    expect(logs[0]).toContain("--label area::prx");
    // No bd/publish plumbing survives GH-1011.
    expect(logs[0]).not.toContain("prx beads publish");
    expect(logs[0]).not.toContain("bd create");
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

// GH-1011: `prx intake bug --title …` files a GitHub issue directly via
// `gh issue create`; the created issue URL is the primary handle. The org's
// front-desk-sync webhook lands the new issue on Front Desk.
describe("runIntake — gh issue create write (GH-1011)", () => {
  test("calls gh issue create once and prints the created issue URL", () => {
    const logs: string[] = [];
    const stub = makeGhCreateStub(42);
    const exitCode = runIntake(
      makeOptions({ type: "bug", title: "broken" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        run: stub.run as never,
        detectBranchName: () => "main",
        cwd: () => "/repo",
      },
    );
    expect(exitCode).toBe(0);
    expect(stub.invocations).toHaveLength(1);
    const cmd = stub.invocations[0]!;
    expect(cmd[0]).toBe("gh");
    expect(cmd.slice(1, 3)).toEqual(["issue", "create"]);
    expect(logs[0]).toBe(stub.issueUrl);
  });

  test("gh argv carries --title and the composed body via --body", () => {
    const stub = makeGhCreateStub();
    runIntake(
      makeOptions({ type: "task", title: "wire up X", body: "some detail" }),
      { log: () => undefined, error: () => undefined },
      {
        run: stub.run as never,
        detectBranchName: () => "main",
        cwd: () => "/repo",
      },
    );
    const cmd = stub.invocations[0]!;
    const titleIdx = cmd.indexOf("--title");
    expect(titleIdx).toBeGreaterThanOrEqual(0);
    expect(cmd[titleIdx + 1]).toBe("task: wire up X");
    const bodyIdx = cmd.indexOf("--body");
    expect(bodyIdx).toBeGreaterThanOrEqual(0);
    expect(cmd[bodyIdx + 1]).toBe("some detail");
  });

  test("labels are passed as repeated --label flags (type stamp folded in)", () => {
    const stub = makeGhCreateStub();
    runIntake(
      makeOptions({ type: "bug", title: "broken" }),
      { log: () => undefined, error: () => undefined },
      {
        run: stub.run as never,
        detectBranchName: () => "main",
        cwd: () => "/repo",
      },
    );
    const cmd = stub.invocations[0]!;
    // Each label is its own `--label <value>` pair.
    const labelValues: string[] = [];
    for (let i = 0; i < cmd.length; i++) {
      if (cmd[i] === "--label") labelValues.push(cmd[i + 1]!);
    }
    expect(labelValues).toContain("type::bug");
  });

  test("spike intent stamps both type::task and type::spike as --label flags", () => {
    const stub = makeGhCreateStub();
    runIntake(
      makeOptions({ type: "spike", title: "explore" }),
      { log: () => undefined, error: () => undefined },
      {
        run: stub.run as never,
        detectBranchName: () => "main",
        cwd: () => "/repo",
      },
    );
    const cmd = stub.invocations[0]!;
    const labelValues: string[] = [];
    for (let i = 0; i < cmd.length; i++) {
      if (cmd[i] === "--label") labelValues.push(cmd[i + 1]!);
    }
    expect(labelValues).toContain("type::task");
    expect(labelValues).toContain("type::spike");
    // Title still uses the spike prefix even though the bd-axis type is task.
    const titleIdx = cmd.indexOf("--title");
    expect(cmd[titleIdx + 1]).toBe("spike: explore");
  });

  test("decision intent stamps both type::task and type::decision", () => {
    const stub = makeGhCreateStub();
    runIntake(
      makeOptions({ type: "decision", title: "design X" }),
      { log: () => undefined, error: () => undefined },
      {
        run: stub.run as never,
        detectBranchName: () => "main",
        cwd: () => "/repo",
      },
    );
    const cmd = stub.invocations[0]!;
    const labelValues: string[] = [];
    for (let i = 0; i < cmd.length; i++) {
      if (cmd[i] === "--label") labelValues.push(cmd[i + 1]!);
    }
    expect(labelValues).toContain("type::task");
    expect(labelValues).toContain("type::decision");
  });

  test("--repo adds -R <repo> before --title", () => {
    const stub = makeGhCreateStub();
    runIntake(
      makeOptions({ type: "bug", title: "broken", repo: "owner/repo" }),
      { log: () => undefined, error: () => undefined },
      {
        run: stub.run as never,
        detectBranchName: () => "main",
        cwd: () => "/repo",
      },
    );
    const cmd = stub.invocations[0]!;
    const rIdx = cmd.indexOf("-R");
    expect(rIdx).toBeGreaterThanOrEqual(0);
    expect(cmd[rIdx + 1]).toBe("owner/repo");
    // -R precedes --title in the argv.
    expect(rIdx).toBeLessThan(cmd.indexOf("--title"));
  });

  test("no --repo omits -R (gh resolves repo from git remote)", () => {
    const stub = makeGhCreateStub();
    runIntake(
      makeOptions({ type: "bug", title: "broken" }),
      { log: () => undefined, error: () => undefined },
      {
        run: stub.run as never,
        detectBranchName: () => "main",
        cwd: () => "/repo",
      },
    );
    expect(stub.invocations[0]!).not.toContain("-R");
  });

  test("configurable issue number flows into the printed URL and JSON result", () => {
    const stub = makeGhCreateStub(7);
    const logs: string[] = [];
    runIntake(
      makeOptions({ type: "bug", title: "broken", format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        run: stub.run as never,
        detectBranchName: () => "main",
        cwd: () => "/repo",
      },
    );
    const result = JSON.parse(logs[0]!);
    expect(result.ghCreate.issueUrl).toBe("https://github.com/bounded-systems/prx/issues/7");
    expect(result.ghCreate.issueNumber).toBe(7);
    expect(result.ghCreate.exitCode).toBe(0);
    // GH-1011: bd-era fields are gone from the result shape.
    expect(result.bdCreate).toBeUndefined();
    expect(result.publish).toBeUndefined();
    expect(result.to).toBeUndefined();
  });

  test("gh issue create failure surfaces stderr and propagates the gh exit code", () => {
    const errors: string[] = [];
    const exitCode = runIntake(
      makeOptions({ type: "task", title: "x" }),
      { log: () => undefined, error: (l) => errors.push(l) },
      {
        run: (() => ({ status: 3, stdout: "", stderr: "gh: auth required\n" })) as never,
        detectBranchName: () => "main",
        cwd: () => "/repo",
      },
    );
    expect(exitCode).toBe(3);
    expect(errors.join("\n")).toContain("prx intake: gh: auth required");
  });

  test("gh success with no issue URL on stdout is a hard error", () => {
    const errors: string[] = [];
    const exitCode = runIntake(
      makeOptions({ type: "task", title: "x" }),
      { log: () => undefined, error: (l) => errors.push(l) },
      {
        run: (() => ({ status: 0, stdout: "created but no url\n", stderr: "" })) as never,
        detectBranchName: () => "main",
        cwd: () => "/repo",
      },
    );
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("did not print an issue URL");
  });
});

describe("composeStructuredBody", () => {
  test("description-only emits a single section", () => {
    expect(composeStructuredBody({ description: "what" })).toBe("## Description\n\nwhat");
  });

  test("design-only emits a single section", () => {
    expect(composeStructuredBody({ design: "how" })).toBe("## Design\n\nhow");
  });

  test("acceptance-only emits Acceptance Criteria heading", () => {
    expect(composeStructuredBody({ acceptance: "done when X" })).toBe(
      "## Acceptance Criteria\n\ndone when X",
    );
  });

  test("notes-only emits a single section", () => {
    expect(composeStructuredBody({ notes: "see Y" })).toBe("## Notes\n\nsee Y");
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
  test("dry-run emits labeled-section body in the gh issue create argv", () => {
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
        run: makeGhCreateStub().run as never,
        detectBranchName: () => "main",
        cwd: () => "/repo",
      },
    );
    // GH-1011: gh's --body carries the composed body (the surfaced-from banner
    // is absent on `main`, so it's just the structured sections).
    expect(logs[0]).toContain(
      "--body '## Description\n\nwhat\n\n## Design\n\nhow\n\n## Acceptance Criteria\n\ndone when X\n\n## Notes\n\nsee Y'",
    );
  });

  test("structured fields are written to gh via --body on create", () => {
    const stub = makeGhCreateStub();
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
        run: stub.run as never,
        detectBranchName: () => "main",
        cwd: () => "/repo",
      },
    );
    expect(stub.invocations).toHaveLength(1);
    const cmd = stub.invocations[0]!;
    const bodyIdx = cmd.indexOf("--body");
    expect(bodyIdx).toBeGreaterThanOrEqual(0);
    const body = cmd[bodyIdx + 1]!;
    expect(body).toContain("## Description\n\nwhat");
    expect(body).toContain("## Design\n\nhow");
    expect(body).toContain("## Acceptance Criteria\n\ndone");
    expect(body).toContain("## Notes\n\ny");
  });
});

describe("runIntake — title prefix mismatch (GH-1304)", () => {
  test("aborts with non-zero exit, no gh calls, stderr message", () => {
    const stub = makeGhCreateStub();
    const errors: string[] = [];
    const logs: string[] = [];
    const exitCode = runIntake(
      makeOptions({ type: "bug", title: "chore(bd): consolidate stuff" }),
      { log: (l) => logs.push(l), error: (l) => errors.push(l) },
      {
        run: stub.run as never,
        detectBranchName: () => "main",
        cwd: () => "/repo",
      },
    );
    expect(exitCode).not.toBe(0);
    expect(stub.invocations).toEqual([]);
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

// GH-1486 / GH-1607: TTY-gated confirm prompt — operator-protection guard
// around any side-effecting write (now bd-first; the confirm wraps both the
// bd-create and optional --to gh projection). Defaults to commit-by-default
// for non-TTY (scripts/CI), requires y/N at a TTY, and `--yes` bypasses the
// prompt. `--dry-run` always wins (no write, no prompt).
describe("runIntake — TTY confirm (GH-1486, GH-1011)", () => {
  test("TTY + confirm 'yes' → gh called, exit 0", () => {
    const stub = makeGhCreateStub();
    let confirmCallCount = 0;
    const exitCode = runIntake(
      makeOptions({ type: "spike", title: "probe" }),
      { log: () => undefined, error: () => undefined },
      {
        run: stub.run as never,
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
    expect(stub.invocations[0]!.slice(0, 3)).toEqual(["gh", "issue", "create"]);
    expect(confirmCallCount).toBe(1);
  });

  test("TTY + confirm 'no' → gh NOT called, exit 1, stderr explains abort", () => {
    const stub = makeGhCreateStub();
    const errors: string[] = [];
    const exitCode = runIntake(
      makeOptions({ type: "spike", title: "probe" }),
      { log: () => undefined, error: (line) => errors.push(line) },
      {
        run: stub.run as never,
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
    expect(errors.join("\n")).toContain("no issue filed");
  });

  test("TTY + --yes → confirm NOT called, gh called once", () => {
    const stub = makeGhCreateStub();
    let confirmCallCount = 0;
    const exitCode = runIntake(
      makeOptions({ type: "spike", title: "probe", yes: true }),
      { log: () => undefined, error: () => undefined },
      {
        run: stub.run as never,
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

  test("non-TTY stdin → confirm NOT called, gh called once (preserves CI/script behavior)", () => {
    const stub = makeGhCreateStub();
    let confirmCallCount = 0;
    const exitCode = runIntake(
      makeOptions({ type: "spike", title: "probe" }),
      { log: () => undefined, error: () => undefined },
      {
        run: stub.run as never,
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

  test("non-TTY stdout (redirected) → confirm NOT called, gh called once", () => {
    const stub = makeGhCreateStub();
    let confirmCallCount = 0;
    const exitCode = runIntake(
      makeOptions({ type: "spike", title: "probe" }),
      { log: () => undefined, error: () => undefined },
      {
        run: stub.run as never,
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

  test("dry-run wins: TTY + dryRun → confirm NOT called, gh NOT called", () => {
    const stub = makeGhCreateStub();
    let confirmCallCount = 0;
    const exitCode = runIntake(
      makeOptions({ type: "spike", title: "probe", dryRun: true }),
      { log: () => undefined, error: () => undefined },
      {
        run: stub.run as never,
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

  test("dry-run wins over --yes: dryRun + yes → no gh call, no prompt", () => {
    const stub = makeGhCreateStub();
    let confirmCallCount = 0;
    const exitCode = runIntake(
      makeOptions({ type: "spike", title: "probe", dryRun: true, yes: true }),
      { log: () => undefined, error: () => undefined },
      {
        run: stub.run as never,
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

  test("default confirm sees the preview headline (not 'prx intake (dry-run)')", () => {
    const stub = makeGhCreateStub();
    let capturedPreview = "";
    runIntake(
      makeOptions({ type: "spike", title: "probe" }),
      { log: () => undefined, error: () => undefined },
      {
        run: stub.run as never,
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
    expect(capturedPreview).toContain("gh issue create");
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
      const msg = result.error.issues.find((i) => i.path[0] === "acceptance")!.message;
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

// GH-1489 / GH-1011: intake stamps `type::<bd_type>` so the type-pass
// classifier's `hasType` gate (GH-957) preserves it on subsequent runs. The
// type/area labels reach GH directly as repeated `--label` flags on the
// `gh issue create` argv.
//
// Helper: run intake and extract the `--label` values off the gh argv.
function capturePublishLabels(
  options: IntakeOptions,
  deps: Partial<Parameters<typeof runIntake>[2]> = {},
): string[] {
  const stub = makeGhCreateStub();
  runIntake(
    options,
    { log: () => undefined, error: () => undefined },
    {
      run: stub.run as never,
      detectBranchName: () => "main",
      cwd: () => "/repo",
      ...deps,
    },
  );
  const cmd = stub.invocations[0] ?? [];
  const labels: string[] = [];
  for (let i = 0; i < cmd.length; i++) {
    if (cmd[i] === "--label") labels.push(cmd[i + 1]!);
  }
  return labels;
}

describe("runIntake — type-label stamping (GH-1489)", () => {
  test("task intent stamps type::task as a gh --label", () => {
    const labels = capturePublishLabels(makeOptions({ type: "task", title: "wire up X" }));
    expect(labels).toContain("type::task");
    // Bd-axis type only; no spike marker for plain task intent.
    expect(labels).not.toContain("type::spike");
  });

  test("spike intent stamps both type::task and type::spike (bd-axis + GH-only)", () => {
    const labels = capturePublishLabels(makeOptions({ type: "spike", title: "explore caching" }));
    expect(labels).toContain("type::task");
    expect(labels).toContain("type::spike");
  });

  test("spike intent + scope folds in area::<scope> alongside both type labels", () => {
    const labels = capturePublishLabels(
      makeOptions({ type: "spike", title: "explore caching", scope: "prx" }),
    );
    expect(labels).toContain("type::task");
    expect(labels).toContain("type::spike");
    expect(labels).toContain("area::prx");
  });

  test("composeTitle('spike', 'task(prx): X') is a prefix mismatch", () => {
    expect(() => composeTitle("spike", "task(prx): explore")).toThrow(IntakeTitleMismatchError);
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
    const labels = capturePublishLabels(
      makeOptions({ type: "bug", title: "x", scope: "beads", to: "gh" }),
    );
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
