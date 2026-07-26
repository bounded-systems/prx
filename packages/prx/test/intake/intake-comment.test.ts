import { describe, expect, test } from "bun:test";
import {
  formatIntakeCommentRender,
  intakeCommentOptionsSchema,
  runIntakeComment,
  type IntakeCommentOptions,
} from "../../src/intake/intake-comment.ts";
import type { GhExecResult } from "@bounded-systems/gh";

type GhCallTag = {
  kind: "gh";
  subcommand: string;
  args: string[];
  state?: string | undefined;
  role?: string | undefined;
};

function makeOpts(overrides: Partial<IntakeCommentOptions> = {}): IntakeCommentOptions {
  return intakeCommentOptionsSchema.parse({
    canonicalId: "GH-200",
    body: "see #555 for context",
    ...overrides,
  });
}

function ghOk(stdout = ""): GhExecResult {
  return { exitCode: 0, stdout, stderr: "", policy: null };
}

function ghFail(stderr: string, code = 1): GhExecResult {
  return { exitCode: code, stdout: "", stderr, policy: null };
}

describe("runIntakeComment — happy path", () => {
  test("posts comment, no close, exit 0", () => {
    const calls: GhCallTag[] = [];
    const exitCode = runIntakeComment(
      makeOpts({ canonicalId: "GH-200", body: "linked from #100" }),
      { log: () => undefined, error: () => undefined },
      {
        execGh: ((opts: { subcommand: string; args: string[] }) => {
          calls.push({ kind: "gh", subcommand: opts.subcommand, args: opts.args });
          return ghOk();
        }) as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: "gh", subcommand: "comment" });
    const args = calls[0]!.args;
    expect(args[0]).toBe("200");
    expect(args).toContain("--body");
    expect(args[args.indexOf("--body") + 1]).toBe("linked from #100");
  });

  test("comment uses planning/executor policy slot", () => {
    const policyCalls: Array<{ state?: string | undefined; role?: string | undefined }> = [];
    runIntakeComment(
      makeOpts(),
      { log: () => undefined, error: () => undefined },
      {
        execGh: ((opts: { state?: string; role?: string }) => {
          policyCalls.push({ state: opts.state, role: opts.role });
          return ghOk();
        }) as never,
      },
    );
    expect(policyCalls[0]).toEqual({ state: "planning", role: "executor" });
  });

  test("body is passed verbatim — no auto-footer or template substitution", () => {
    const calls: GhCallTag[] = [];
    runIntakeComment(
      makeOpts({ body: "raw body ${canonical} kept literal" }),
      { log: () => undefined, error: () => undefined },
      {
        execGh: ((opts: { subcommand: string; args: string[] }) => {
          calls.push({ kind: "gh", subcommand: opts.subcommand, args: opts.args });
          return ghOk();
        }) as never,
      },
    );
    const bodyArg = calls[0]!.args[calls[0]!.args.indexOf("--body") + 1];
    expect(bodyArg).toBe("raw body ${canonical} kept literal");
  });
});

describe("runIntakeComment — comment failure", () => {
  test("propagates exit code, surfaces stderr", () => {
    const errors: string[] = [];
    const exitCode = runIntakeComment(
      makeOpts(),
      { log: () => undefined, error: (l) => errors.push(l) },
      {
        execGh: (() => ghFail("permission denied", 2)) as never,
      },
    );
    expect(exitCode).toBe(2);
    expect(errors.join("\n")).toContain("permission denied");
    expect(errors.join("\n")).toContain("prx intake comment");
  });
});

describe("runIntakeComment — dry-run (gh arm)", () => {
  test("renders argv, no spawn, exit 0", () => {
    const calls: GhCallTag[] = [];
    const logs: string[] = [];
    const exitCode = runIntakeComment(
      makeOpts({ canonicalId: "GH-200", body: "x", dryRun: true }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        execGh: ((opts: { subcommand: string; args: string[] }) => {
          calls.push({ kind: "gh", subcommand: opts.subcommand, args: opts.args });
          return ghOk();
        }) as never,
      },
    );

    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(0);
    const out = logs[0]!;
    expect(out).toContain("dry-run");
    expect(out).toContain("canonical:  GH-200");
    expect(out).toContain("gh issue comment 200");
    expect(out).not.toContain("close");
    expect(out).not.toContain("label");
  });

  test("dry-run json output is valid JSON with expected shape", () => {
    const logs: string[] = [];
    runIntakeComment(
      makeOpts({ dryRun: true, format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        execGh: (() => ghOk()) as never,
      },
    );
    const parsed = JSON.parse(logs[0]!) as {
      backend: "gh";
      canonicalNumber: number;
      dryRun: boolean;
      comment: { argv: string[]; body: string };
    };
    expect(parsed.backend).toBe("gh");
    expect(parsed.canonicalNumber).toBe(200);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.comment.body).toBe("see #555 for context");
    expect(parsed.comment.argv).toContain("comment");
    expect(parsed.comment.argv).toContain("--body");
    // Render must not carry close/label keys.
    expect(JSON.stringify(parsed)).not.toContain('"close"');
    expect(JSON.stringify(parsed)).not.toContain('"label"');
  });
});

describe("runIntakeComment — id dispatch", () => {
  test("bd-shaped id is refused (bd has no writable comment surface)", () => {
    const ghCalls: GhCallTag[] = [];
    const errors: string[] = [];
    const exitCode = runIntakeComment(
      makeOpts({ canonicalId: "ai-home-gmkwh", body: "follow-up note" }),
      { log: () => undefined, error: (l) => errors.push(l) },
      {
        execGh: ((opts: { subcommand: string; args: string[] }) => {
          ghCalls.push({ kind: "gh", subcommand: opts.subcommand, args: opts.args });
          return ghOk();
        }) as never,
      },
    );

    expect(exitCode).toBe(1);
    expect(ghCalls).toHaveLength(0);
    expect(errors.join("\n")).toContain("GitHub issue");
    expect(errors.join("\n")).toContain("bd");
  });

  test("notion-shaped id is refused", () => {
    const errors: string[] = [];
    const exitCode = runIntakeComment(
      makeOpts({
        canonicalId: "11111111-1111-1111-1111-111111111111",
      }),
      { log: () => undefined, error: (l) => errors.push(l) },
      {
        execGh: (() => ghOk()) as never,
      },
    );
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Notion");
    expect(errors.join("\n")).toContain("prx scout notion");
  });

  test("shell-metachar input is rejected by shared resolver", () => {
    const errors: string[] = [];
    const exitCode = runIntakeComment(
      makeOpts({ canonicalId: "foo;rm" }),
      { log: () => undefined, error: (l) => errors.push(l) },
      {
        execGh: (() => ghOk()) as never,
      },
    );
    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("invalid characters");
  });
});

describe("runIntakeComment — schema", () => {
  test("empty body is rejected at the schema layer", () => {
    expect(() => intakeCommentOptionsSchema.parse({ canonicalId: "GH-1", body: "" })).toThrow();
  });

  test("missing canonicalId is rejected", () => {
    expect(() => intakeCommentOptionsSchema.parse({ canonicalId: "", body: "x" })).toThrow();
  });
});

describe("runIntakeComment — flag passthrough", () => {
  test("URL form supplies --repo to gh", () => {
    const calls: GhCallTag[] = [];
    runIntakeComment(
      makeOpts({
        canonicalId: "https://github.com/o/r/issues/200",
      }),
      { log: () => undefined, error: () => undefined },
      {
        execGh: ((opts: { subcommand: string; args: string[] }) => {
          calls.push({ kind: "gh", subcommand: opts.subcommand, args: opts.args });
          return ghOk();
        }) as never,
      },
    );
    const args = calls[0]!.args;
    expect(args).toContain("--repo");
    expect(args[args.indexOf("--repo") + 1]).toBe("o/r");
  });

  test("explicit --repo wins over URL-form repo", () => {
    const calls: GhCallTag[] = [];
    runIntakeComment(
      makeOpts({
        canonicalId: "https://github.com/o/r/issues/200",
        repo: "explicit/repo",
      }),
      { log: () => undefined, error: () => undefined },
      {
        execGh: ((opts: { subcommand: string; args: string[] }) => {
          calls.push({ kind: "gh", subcommand: opts.subcommand, args: opts.args });
          return ghOk();
        }) as never,
      },
    );
    const args = calls[0]!.args;
    expect(args[args.indexOf("--repo") + 1]).toBe("explicit/repo");
  });
});

describe("formatIntakeCommentRender — copy-paste-safe argv quoting", () => {
  test("body containing `#` is single-quoted in dry-run argv (POSIX comment guard)", () => {
    const logs: string[] = [];
    runIntakeComment(
      makeOpts({ canonicalId: "GH-200", body: "#123", dryRun: true }),
      { log: (l) => logs.push(l), error: () => undefined },
      { execGh: (() => ghOk()) as never },
    );
    const out = logs[0]!;
    // Must be quoted — `gh issue comment 200 --body #123` would be eaten as
    // a shell comment when copy-pasted.
    expect(out).toContain("--body '#123'");
    expect(out).not.toContain("--body #123");
  });

  test("body with leading mention (`@alice`) is single-quoted in dry-run argv", () => {
    const logs: string[] = [];
    runIntakeComment(
      makeOpts({ canonicalId: "GH-200", body: "@alice please review", dryRun: true }),
      { log: (l) => logs.push(l), error: () => undefined },
      { execGh: (() => ghOk()) as never },
    );
    expect(logs[0]).toContain("'@alice please review'");
  });
});

describe("formatIntakeCommentRender — multi-line body", () => {
  test("plain render emits `comment:` heading + indented continuation lines", () => {
    const out = formatIntakeCommentRender(
      {
        backend: "gh",
        canonicalNumber: 200,
        repo: undefined,
        comment: {
          argv: ["issue", "comment", "200", "--body", "line one\nline two\nline three"],
          body: "line one\nline two\nline three",
        },
        dryRun: false,
        exitCode: 0,
      },
      "plain",
    );
    // Heading appears bare (no inline first line) so continuation lines
    // share the same indent.
    expect(out).toContain("\n  comment:\n");
    expect(out).toContain("    line one");
    expect(out).toContain("    line two");
    expect(out).toContain("    line three");
    // No raw "comment:    line one" inline form when body is multi-line.
    expect(out).not.toContain("comment:    line one");
  });

  test("plain render keeps the inline single-line form for one-line bodies", () => {
    const out = formatIntakeCommentRender(
      {
        backend: "gh",
        canonicalNumber: 200,
        repo: undefined,
        comment: {
          argv: ["issue", "comment", "200", "--body", "single"],
          body: "single",
        },
        dryRun: false,
        exitCode: 0,
      },
      "plain",
    );
    expect(out).toContain("  comment:    single");
  });
});

describe("formatIntakeCommentRender", () => {
  test("plain dry-run includes 'would run:' header and no close line", () => {
    const out = formatIntakeCommentRender(
      {
        backend: "gh",
        canonicalNumber: 200,
        repo: undefined,
        comment: {
          argv: ["issue", "comment", "200", "--body", "hello"],
          body: "hello",
        },
        dryRun: true,
        exitCode: 0,
      },
      "plain",
    );
    expect(out).toContain("(dry-run)");
    expect(out).toContain("would run:");
    expect(out).toContain("gh issue comment 200");
    expect(out).not.toContain("close");
  });

  test("plain non-dry-run shows comment line, no would-run", () => {
    const out = formatIntakeCommentRender(
      {
        backend: "gh",
        canonicalNumber: 200,
        repo: "o/r",
        comment: {
          argv: ["issue", "comment", "200", "--body", "hello"],
          body: "hello",
        },
        dryRun: false,
        exitCode: 0,
      },
      "plain",
    );
    expect(out).not.toContain("(dry-run)");
    expect(out).not.toContain("would run:");
    expect(out).toContain("comment:    hello");
    expect(out).toContain("repo:       o/r");
  });
});
