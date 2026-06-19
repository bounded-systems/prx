import { describe, expect, test } from "bun:test";
import {
  formatIntakeViewRender,
  resolveIntakeViewId,
  runIntakeView,
  type GhIssueViewPayload,
  type IntakeViewOptions,
} from "../../src/intake/intake-view.ts";
import type { GhExecResult } from "@bounded-systems/gh";
import type { BeadsRecord } from "../../src/triage/triage.ts";

function makeOpts(overrides: Partial<IntakeViewOptions> = {}): IntakeViewOptions {
  return { id: "GH-1", format: "plain", ...overrides };
}

function ghOk(payload: Partial<GhIssueViewPayload> = {}): GhExecResult {
  const full: GhIssueViewPayload = {
    title: "t",
    state: "OPEN",
    labels: [],
    body: "",
    comments: [],
    url: "https://github.com/o/r/issues/1",
    ...payload,
  };
  return {
    exitCode: 0,
    stdout: JSON.stringify(full),
    stderr: "",
    policy: null,
  };
}

function ghFail(stderr: string, code = 1): GhExecResult {
  return { exitCode: code, stdout: "", stderr, policy: null };
}

function bead(overrides: Partial<BeadsRecord> = {}): BeadsRecord {
  return {
    id: "ai-home-xyz",
    title: "bd title",
    description: "bd description",
    status: "open",
    priority: 2,
    issueType: "task",
    externalRef: null,
    externalRefs: {},
    metadata: null,
    externalIssueNumber: null,
    sourceSystem: null,
    ...overrides,
  };
}

describe("resolveIntakeViewId", () => {
  test("GH-N (uppercase)", () => {
    expect(resolveIntakeViewId("GH-1000")).toEqual({ kind: "gh", number: 1000 });
  });

  test("gh-N (lowercase) is accepted via case-insensitive prefix", () => {
    expect(resolveIntakeViewId("gh-42")).toEqual({ kind: "gh", number: 42 });
  });

  test("#N", () => {
    expect(resolveIntakeViewId("#950")).toEqual({ kind: "gh", number: 950 });
  });

  test("bare integer", () => {
    expect(resolveIntakeViewId("1000")).toEqual({ kind: "gh", number: 1000 });
  });

  test("GitHub URL captures owner/repo + number", () => {
    expect(resolveIntakeViewId("https://github.com/bdelanghe/ai-home/issues/1000")).toEqual({
      kind: "gh",
      number: 1000,
      repo: "bdelanghe/ai-home",
    });
  });

  test("GitHub URL with trailing slash and query string", () => {
    expect(resolveIntakeViewId("https://github.com/o/r/issues/7/?foo=bar")).toEqual({
      kind: "gh",
      number: 7,
      repo: "o/r",
    });
  });

  test("GitHub URL with multi-param query string (& not rejected; GH-1186 review)", () => {
    expect(
      resolveIntakeViewId("https://github.com/bdelanghe/ai-home/issues/1186?foo=1&bar=2"),
    ).toEqual({ kind: "gh", number: 1186, repo: "bdelanghe/ai-home" });
  });

  test("bd id (catch-all) when no GH form matches", () => {
    expect(resolveIntakeViewId("ai-home-abc123")).toEqual({
      kind: "bd",
      id: "ai-home-abc123",
    });
  });

  test("rejects empty / whitespace input", () => {
    expect(() => resolveIntakeViewId("")).toThrow();
    expect(() => resolveIntakeViewId("   ")).toThrow();
  });

  test("rejects shell-metachar inputs", () => {
    expect(() => resolveIntakeViewId("foo;rm")).toThrow();
    expect(() => resolveIntakeViewId("foo bar")).toThrow();
    expect(() => resolveIntakeViewId("$(whoami)")).toThrow();
  });
});

describe("runIntakeView — GH paths", () => {
  test("GH-N invokes gh issue view with the parsed number", async () => {
    const calls: Array<{ subcommand: string; args: string[]; group: string }> = [];
    const exitCode = await runIntakeView(
      makeOpts({ id: "GH-1000" }),
      { log: () => undefined, error: () => undefined },
      {
        execGh: ((opts: { group: string; subcommand: string; args: string[] }) => {
          calls.push(opts);
          return ghOk();
        }) as never,
      },
    );
    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.group).toBe("issue");
    expect(calls[0]!.subcommand).toBe("view");
    expect(calls[0]!.args[0]).toBe("1000");
    expect(calls[0]!.args).toContain("--json");
    expect(calls[0]!.args).not.toContain("--repo");
  });

  test("URL form forwards --repo owner/repo", async () => {
    const calls: Array<{ args: string[] }> = [];
    await runIntakeView(
      makeOpts({ id: "https://github.com/bdelanghe/ai-home/issues/1000" }),
      { log: () => undefined, error: () => undefined },
      {
        execGh: ((opts: { args: string[] }) => {
          calls.push({ args: opts.args });
          return ghOk();
        }) as never,
      },
    );
    expect(calls[0]!.args).toContain("--repo");
    const repoIdx = calls[0]!.args.indexOf("--repo");
    expect(calls[0]!.args[repoIdx + 1]).toBe("bdelanghe/ai-home");
  });

  test("plain output renders title/state/labels/url/body and comment thread", async () => {
    const logs: string[] = [];
    await runIntakeView(
      makeOpts({ id: "1000", format: "plain" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        execGh: (() =>
          ghOk({
            title: "task: ship view",
            state: "OPEN",
            labels: [{ name: "type::task" }, { name: "area::prx" }],
            body: "the body",
            comments: [
              { author: { login: "alice" }, createdAt: "2026-01-02T03:04:05Z", body: "first" },
            ],
            url: "https://github.com/o/r/issues/1000",
          })) as never,
      },
    );
    expect(logs).toHaveLength(1);
    const out = logs[0]!;
    expect(out).toContain("title:  task: ship view");
    expect(out).toContain("state:  OPEN");
    expect(out).toContain("labels: type::task, area::prx");
    expect(out).toContain("url:    https://github.com/o/r/issues/1000");
    expect(out).toContain("the body");
    expect(out).toContain("--- comments (1) ---");
    expect(out).toContain("@alice (2026-01-02T03:04:05Z):");
    expect(out).toContain("  first");
  });

  test("json output wraps payload as { source: 'gh', payload: ... }", async () => {
    const logs: string[] = [];
    await runIntakeView(
      makeOpts({ id: "GH-7", format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        execGh: (() => ghOk({ title: "x", url: "https://github.com/o/r/issues/7" })) as never,
      },
    );
    const parsed = JSON.parse(logs[0]!) as { source: string; payload: { url: string } };
    expect(parsed.source).toBe("gh");
    expect(parsed.payload.url).toBe("https://github.com/o/r/issues/7");
  });

  test("propagates gh exit code on failure with stderr message", async () => {
    const errors: string[] = [];
    const exitCode = await runIntakeView(
      makeOpts({ id: "GH-99" }),
      { log: () => undefined, error: (l) => errors.push(l) },
      { execGh: (() => ghFail("gh: not found", 2)) as never },
    );
    expect(exitCode).toBe(2);
    expect(errors[0]).toContain("gh: not found");
  });
});

describe("runIntakeView — bd paths", () => {
  test("bd id with no external_ref renders the bd record directly", async () => {
    const logs: string[] = [];
    let ghCalls = 0;
    const exitCode = await runIntakeView(
      makeOpts({ id: "ai-home-xyz" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        execGh: (() => {
          ghCalls++;
          return ghOk();
        }) as never,
        showBead: (async () =>
          bead({ id: "ai-home-xyz", title: "bd-only thing", externalRef: null })) as never,
      },
    );
    expect(exitCode).toBe(0);
    expect(ghCalls).toBe(0);
    expect(logs[0]).toContain("title:    bd-only thing");
    expect(logs[0]).toContain("bd-id:    ai-home-xyz");
    expect(logs[0]).toContain("external: (none)");
  });

  test("bd id with GH external_ref re-resolves to gh issue view", async () => {
    const ghCalls: Array<{ args: string[] }> = [];
    const logs: string[] = [];
    await runIntakeView(
      makeOpts({ id: "ai-home-xyz" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        execGh: ((opts: { args: string[] }) => {
          ghCalls.push({ args: opts.args });
          return ghOk({ title: "from gh", url: "https://github.com/o/r/issues/123" });
        }) as never,
        showBead: (async () =>
          bead({
            id: "ai-home-xyz",
            externalRef: "https://github.com/o/r/issues/123",
          })) as never,
      },
    );
    expect(ghCalls).toHaveLength(1);
    expect(ghCalls[0]!.args[0]).toBe("123");
    expect(logs[0]).toContain("title:  from gh");
  });

  test("bd id with no matching record errors with exit 1", async () => {
    const errors: string[] = [];
    const exitCode = await runIntakeView(
      makeOpts({ id: "ai-home-missing" }),
      { log: () => undefined, error: (l) => errors.push(l) },
      {
        execGh: (() => ghOk()) as never,
        showBead: (async () => null) as never,
      },
    );
    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("ai-home-missing");
  });

  test("bd json output wraps the bd record with source='bd'", async () => {
    const logs: string[] = [];
    await runIntakeView(
      makeOpts({ id: "ai-home-xyz", format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        execGh: (() => ghOk()) as never,
        showBead: (async () => bead({ id: "ai-home-xyz" })) as never,
      },
    );
    const parsed = JSON.parse(logs[0]!) as { source: string; payload: { id: string } };
    expect(parsed.source).toBe("bd");
    expect(parsed.payload.id).toBe("ai-home-xyz");
  });
});

describe("runIntakeView — notion paths (GH-874)", () => {
  test("Notion UUID dispatches to runScoutNotion and renders the result", async () => {
    const calls: Array<{ id: string }> = [];
    const logs: string[] = [];
    const exitCode = await runIntakeView(
      makeOpts({ id: "550e8400-e29b-41d4-a716-446655440000" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        runScoutNotion: (async (input: { id: string }) => {
          calls.push({ id: input.id });
          return {
            uuid: input.id,
            task_id: null,
            title: "from notion",
            body: "notion body",
            url: "https://www.notion.so/page-id",
            state: "open" as const,
            gh_issue: null,
            bd_id: null,
            intake_shape: { type: null, title: "from notion", body: "notion body" },
          };
        }) as never,
      },
    );
    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.id).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(logs[0]).toContain("title:    from notion");
  });

  test("Notion Task-ID dispatches to runScoutNotion", async () => {
    const calls: Array<{ id: string }> = [];
    await runIntakeView(
      makeOpts({ id: "OPS-42" }),
      { log: () => undefined, error: () => undefined },
      {
        runScoutNotion: (async (input: { id: string }) => {
          calls.push({ id: input.id });
          return {
            uuid: "550e8400-e29b-41d4-a716-446655440000",
            task_id: input.id,
            title: "task",
            body: null,
            url: null,
            state: "unknown" as const,
            gh_issue: null,
            bd_id: null,
            intake_shape: { type: null, title: "task", body: null },
          };
        }) as never,
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.id).toBe("OPS-42");
  });

  test("Notion json output wraps result with source='notion'", async () => {
    const logs: string[] = [];
    await runIntakeView(
      makeOpts({ id: "550e8400-e29b-41d4-a716-446655440000", format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        runScoutNotion: (async () => ({
          uuid: "550e8400-e29b-41d4-a716-446655440000",
          task_id: null,
          title: "t",
          body: null,
          url: null,
          state: "open" as const,
          gh_issue: null,
          bd_id: null,
          intake_shape: { type: null, title: "t", body: null },
        })) as never,
      },
    );
    const parsed = JSON.parse(logs[0]!) as { source: string };
    expect(parsed.source).toBe("notion");
  });
});

describe("runIntakeView — input validation", () => {
  test("empty id returns exit 1 and writes to stderr", async () => {
    const errors: string[] = [];
    const exitCode = await runIntakeView(
      makeOpts({ id: "" }),
      { log: () => undefined, error: (l) => errors.push(l) },
      { execGh: (() => ghOk()) as never },
    );
    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("must not be empty");
  });

  test("shell-metachar id returns exit 1", async () => {
    const errors: string[] = [];
    const exitCode = await runIntakeView(
      makeOpts({ id: "foo;rm" }),
      { log: () => undefined, error: (l) => errors.push(l) },
      { execGh: (() => ghOk()) as never },
    );
    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("invalid characters");
  });
});

describe("formatIntakeViewRender", () => {
  test("plain gh render with no comments shows '--- comments (0) ---'", () => {
    const out = formatIntakeViewRender(
      {
        source: "gh",
        payload: {
          title: "t",
          state: "OPEN",
          labels: [],
          body: "b",
          comments: [],
          url: "u",
        },
      },
      "plain",
    );
    expect(out).toContain("--- comments (0) ---");
    expect(out).toContain("labels: (none)");
  });

  test("plain bd render shows priority and status", () => {
    const out = formatIntakeViewRender(
      { source: "bd", payload: bead({ priority: 0, status: "blocked" }) },
      "plain",
    );
    expect(out).toContain("priority: P0");
    expect(out).toContain("status:   blocked");
  });

  test("plain bd render shows '(unscored)' when priority is null", () => {
    const out = formatIntakeViewRender(
      { source: "bd", payload: bead({ priority: null }) },
      "plain",
    );
    expect(out).toContain("priority: (unscored)");
  });
});
