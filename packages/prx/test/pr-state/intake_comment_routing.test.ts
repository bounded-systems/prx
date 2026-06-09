// GH-1323: parser-routing tests for `prx intake comment`. The leaf-handler
// tests in test/intake/intake-comment.test.ts cover schemas/handlers
// directly; this file drives the public CLI seam (`runCli`) so a regression
// in `parseCommand` ordering, body-source mutex, or `--body @file`
// promotion is caught here.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../../src/pr-state/cli.ts";

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

function captureOutput(): { logs: string[]; errors: string[]; output: Output } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    output: {
      log: (line: string) => logs.push(line),
      error: (line: string) => errors.push(line),
    },
  };
}

describe("runCli — `prx intake comment` parser routing", () => {
  test("routes `intake comment GH-200 --body 'x'` to runIntakeComment", async () => {
    const { output } = captureOutput();
    const captured: Array<{ canonicalId: string; body: string; dryRun: boolean }> = [];
    const exit = await runCli(
      ["intake", "comment", "GH-200", "--body", "linked from #100"],
      output,
      {
        runIntakeComment: (opts) => {
          captured.push({
            canonicalId: opts.canonicalId,
            body: opts.body,
            dryRun: opts.dryRun,
          });
          return 0;
        },
      },
    );
    expect(exit).toBe(0);
    expect(captured).toEqual([
      { canonicalId: "GH-200", body: "linked from #100", dryRun: false },
    ]);
  });

  test("routes a bd-shaped positional `ai-home-<slug>` to runIntakeComment (handler dispatches bd arm)", async () => {
    // GH-1913: the parser passes the positional through as `canonicalId`
    // without back-end validation — the resolver inside `runIntakeComment`
    // routes gh vs bd. This test pins the parser→handler seam so the bd id
    // reaches the handler unchanged.
    const { output } = captureOutput();
    const captured: Array<{ canonicalId: string; body: string }> = [];
    const exit = await runCli(
      ["intake", "comment", "ai-home-gmkwh", "--body", "follow-up note"],
      output,
      {
        runIntakeComment: (opts) => {
          captured.push({
            canonicalId: opts.canonicalId,
            body: opts.body,
          });
          return 0;
        },
      },
    );
    expect(exit).toBe(0);
    expect(captured).toEqual([
      { canonicalId: "ai-home-gmkwh", body: "follow-up note" },
    ]);
  });

  test("missing positional fails with a usage-style error", async () => {
    const { errors, output } = captureOutput();
    const exit = await runCli(["intake", "comment"], output, {});
    expect(exit).not.toBe(0);
    expect(
      errors.some((l) =>
        l.includes("intake comment requires one positional"),
      ),
    ).toBe(true);
  });

  test("missing body source fails (no --body / --body-file / --body-stdin)", async () => {
    const { errors, output } = captureOutput();
    const exit = await runCli(
      ["intake", "comment", "GH-200"],
      output,
      {},
    );
    expect(exit).not.toBe(0);
    expect(
      errors.some((l) => l.includes("intake comment requires a body")),
    ).toBe(true);
  });

  test("--body and --body-stdin together are rejected at parse layer", async () => {
    const { errors, output } = captureOutput();
    const exit = await runCli(
      ["intake", "comment", "GH-200", "--body", "x", "--body-stdin"],
      output,
      {},
    );
    expect(exit).not.toBe(0);
    expect(
      errors.some((l) =>
        l.includes(
          "--body, --body-file, and --body-stdin are mutually exclusive",
        ),
      ),
    ).toBe(true);
  });

  test("--body and --body-file together are rejected at parse layer", async () => {
    const { errors, output } = captureOutput();
    const exit = await runCli(
      ["intake", "comment", "GH-200", "--body", "x", "--body-file", "body.md"],
      output,
      {},
    );
    expect(exit).not.toBe(0);
    expect(
      errors.some((l) =>
        l.includes(
          "--body, --body-file, and --body-stdin are mutually exclusive",
        ),
      ),
    ).toBe(true);
  });

  test("--body-file PATH and --body-stdin together are rejected", async () => {
    const { errors, output } = captureOutput();
    const exit = await runCli(
      [
        "intake",
        "comment",
        "GH-200",
        "--body-file",
        "body.md",
        "--body-stdin",
      ],
      output,
      {},
    );
    expect(exit).not.toBe(0);
    expect(
      errors.some((l) =>
        l.includes(
          "--body, --body-file, and --body-stdin are mutually exclusive",
        ),
      ),
    ).toBe(true);
  });

  test("--repo flag forwards through to handler", async () => {
    const { output } = captureOutput();
    const captured: Array<{ repo?: string | undefined }> = [];
    await runCli(
      ["intake", "comment", "GH-200", "--body", "x", "--repo", "o/r"],
      output,
      {
        runIntakeComment: (opts) => {
          captured.push({ repo: opts.repo });
          return 0;
        },
      },
    );
    expect(captured).toEqual([{ repo: "o/r" }]);
  });

  test("--dry-run is forwarded", async () => {
    const { output } = captureOutput();
    const captured: Array<{ dryRun: boolean }> = [];
    await runCli(
      ["intake", "comment", "GH-200", "--body", "x", "--dry-run"],
      output,
      {
        runIntakeComment: (opts) => {
          captured.push({ dryRun: opts.dryRun });
          return 0;
        },
      },
    );
    expect(captured).toEqual([{ dryRun: true }]);
  });

  test("--json flips format before dispatch", async () => {
    const { output } = captureOutput();
    const captured: Array<{ format: "plain" | "json" }> = [];
    await runCli(
      ["intake", "comment", "GH-200", "--body", "x", "--json"],
      output,
      {
        runIntakeComment: (opts) => {
          captured.push({ format: opts.format });
          return 0;
        },
      },
    );
    expect(captured).toEqual([{ format: "json" }]);
  });

  test("extra positional is rejected", async () => {
    const { errors, output } = captureOutput();
    const exit = await runCli(
      ["intake", "comment", "GH-200", "extra", "--body", "x"],
      output,
      {},
    );
    expect(exit).not.toBe(0);
    expect(
      errors.some((l) =>
        l.includes("intake comment: unexpected extra positionals"),
      ),
    ).toBe(true);
  });
});

describe("runCli — `prx intake comment --body @file` and --body-file", () => {
  let tmp: string;
  let bodyPath: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "intake-comment-routing-"));
    bodyPath = join(tmp, "body.md");
    writeFileSync(bodyPath, "from a file\nwith newlines\n", "utf8");
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("--body @file is promoted to bodyFile and read at the CLI layer", async () => {
    const { output } = captureOutput();
    const captured: Array<{ body: string }> = [];
    const exit = await runCli(
      ["intake", "comment", "GH-200", "--body", `@${bodyPath}`],
      output,
      {
        runIntakeComment: (opts) => {
          captured.push({ body: opts.body });
          return 0;
        },
      },
    );
    expect(exit).toBe(0);
    expect(captured).toEqual([{ body: "from a file\nwith newlines\n" }]);
  });

  test("--body-file PATH reads from disk at the CLI layer", async () => {
    const { output } = captureOutput();
    const captured: Array<{ body: string }> = [];
    const exit = await runCli(
      ["intake", "comment", "GH-200", "--body-file", bodyPath],
      output,
      {
        runIntakeComment: (opts) => {
          captured.push({ body: opts.body });
          return 0;
        },
      },
    );
    expect(exit).toBe(0);
    expect(captured).toEqual([{ body: "from a file\nwith newlines\n" }]);
  });

  test("`--body @alice` (mention shape, no `/`) stays a literal body — not a file path", async () => {
    const { output } = captureOutput();
    const captured: Array<{ body: string }> = [];
    const exit = await runCli(
      ["intake", "comment", "GH-200", "--body", "@alice please review"],
      output,
      {
        runIntakeComment: (opts) => {
          captured.push({ body: opts.body });
          return 0;
        },
      },
    );
    expect(exit).toBe(0);
    expect(captured).toEqual([{ body: "@alice please review" }]);
  });

  test("`--body @alice` (single-token mention) stays a literal body", async () => {
    const { output } = captureOutput();
    const captured: Array<{ body: string }> = [];
    const exit = await runCli(
      ["intake", "comment", "GH-200", "--body", "@alice"],
      output,
      {
        runIntakeComment: (opts) => {
          captured.push({ body: opts.body });
          return 0;
        },
      },
    );
    expect(exit).toBe(0);
    expect(captured).toEqual([{ body: "@alice" }]);
  });

  test("`--body @path` and `--body-file path` together is a parse-layer error", async () => {
    const { errors, output } = captureOutput();
    const exit = await runCli(
      [
        "intake",
        "comment",
        "GH-200",
        "--body",
        `@${bodyPath}`,
        "--body-file",
        bodyPath,
      ],
      output,
      {},
    );
    expect(exit).not.toBe(0);
    expect(
      errors.some((l) =>
        l.includes("--body @file and --body-file are mutually exclusive"),
      ),
    ).toBe(true);
  });
});
