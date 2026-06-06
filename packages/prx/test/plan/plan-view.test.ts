import { describe, expect, test } from "bun:test";

import {
  runPlanView,
  type PlanViewOptions,
} from "../../src/plan-store/plan-view.ts";
import type { GhIssueViewPayload } from "../../src/issues/render.ts";
import type { GhExecResult } from "@bounded-systems/gh";
import type { BeadsRecord } from "../../src/triage/triage.ts";

function makeOpts(overrides: Partial<PlanViewOptions> = {}): PlanViewOptions {
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
  return { exitCode: 0, stdout: JSON.stringify(full), stderr: "", policy: null };
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

describe("runPlanView — id resolution forwards to gh issue view", () => {
  test("GH-N invokes gh issue view with the parsed number", async () => {
    const calls: Array<{ subcommand: string; args: string[]; group: string }> = [];
    const exitCode = await runPlanView(
      makeOpts({ id: "GH-1186" }),
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
    expect(calls[0]!.args[0]).toBe("1186");
    expect(calls[0]!.args).toContain("--json");
  });

  test("#N form parses to a bare GH number", async () => {
    const calls: Array<{ args: string[] }> = [];
    await runPlanView(
      makeOpts({ id: "#1242" }),
      { log: () => undefined, error: () => undefined },
      {
        execGh: ((opts: { args: string[] }) => {
          calls.push({ args: opts.args });
          return ghOk();
        }) as never,
      },
    );
    expect(calls[0]!.args[0]).toBe("1242");
  });

  test("bare integer parses to a GH issue number", async () => {
    const calls: Array<{ args: string[] }> = [];
    await runPlanView(
      makeOpts({ id: "1186" }),
      { log: () => undefined, error: () => undefined },
      {
        execGh: ((opts: { args: string[] }) => {
          calls.push({ args: opts.args });
          return ghOk();
        }) as never,
      },
    );
    expect(calls[0]!.args[0]).toBe("1186");
  });

  test("URL form forwards --repo owner/repo", async () => {
    const calls: Array<{ args: string[] }> = [];
    await runPlanView(
      makeOpts({ id: "https://github.com/bdelanghe/ai-home/issues/1186" }),
      { log: () => undefined, error: () => undefined },
      {
        execGh: ((opts: { args: string[] }) => {
          calls.push({ args: opts.args });
          return ghOk();
        }) as never,
      },
    );
    expect(calls[0]!.args).toContain("--repo");
    expect(calls[0]!.args[calls[0]!.args.indexOf("--repo") + 1]).toBe(
      "bdelanghe/ai-home",
    );
  });

  test("plain output renders title/state/labels/url/body and comment thread", async () => {
    const logs: string[] = [];
    await runPlanView(
      makeOpts({ id: "1186", format: "plain" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        execGh: (() =>
          ghOk({
            title: "epic: plan-session verb-surface closure",
            state: "OPEN",
            labels: [{ name: "type::epic" }, { name: "axis::scope" }],
            body: "the body",
            comments: [
              { author: { login: "dana" }, createdAt: "2026-05-02T00:00:00Z", body: "first" },
            ],
            url: "https://github.com/o/r/issues/1186",
          })) as never,
      },
    );
    expect(logs).toHaveLength(1);
    const out = logs[0]!;
    expect(out).toContain("title:  epic: plan-session verb-surface closure");
    expect(out).toContain("state:  OPEN");
    expect(out).toContain("labels: type::epic, axis::scope");
    expect(out).toContain("url:    https://github.com/o/r/issues/1186");
    expect(out).toContain("--- comments (1) ---");
    expect(out).toContain("@dana (2026-05-02T00:00:00Z):");
    expect(out).toContain("  first");
  });

  test("json output wraps payload as { source: 'gh', payload }", async () => {
    const logs: string[] = [];
    await runPlanView(
      makeOpts({ id: "GH-1", format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      { execGh: (() => ghOk()) as never },
    );
    const parsed = JSON.parse(logs[0]!) as { source: string; payload: { url: string } };
    expect(parsed.source).toBe("gh");
    expect(parsed.payload.url).toBe("https://github.com/o/r/issues/1");
  });

  test("propagates gh exit code on failure with stderr message prefixed by verb", async () => {
    const errors: string[] = [];
    const exitCode = await runPlanView(
      makeOpts({ id: "GH-99" }),
      { log: () => undefined, error: (l) => errors.push(l) },
      { execGh: (() => ghFail("gh: not found", 2)) as never },
    );
    expect(exitCode).toBe(2);
    expect(errors[0]).toContain("prx plan view");
    expect(errors[0]).toContain("gh: not found");
  });
});

describe("runPlanView — bd paths", () => {
  test("bd id with no external_ref renders the bd record directly", async () => {
    const logs: string[] = [];
    let ghCalls = 0;
    const exitCode = await runPlanView(
      makeOpts({ id: "ai-home-xyz" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        execGh: (() => {
          ghCalls++;
          return ghOk();
        }) as never,
        loadBeads: (async () => [
          bead({ id: "ai-home-xyz", title: "bd-only thing", externalRef: null }),
        ]) as never,
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
    await runPlanView(
      makeOpts({ id: "ai-home-xyz" }),
      { log: () => undefined, error: () => undefined },
      {
        execGh: ((opts: { args: string[] }) => {
          ghCalls.push({ args: opts.args });
          return ghOk({ title: "from gh", url: "https://github.com/o/r/issues/123" });
        }) as never,
        loadBeads: (async () => [
          bead({
            id: "ai-home-xyz",
            externalRef: "https://github.com/o/r/issues/123",
          }),
        ]) as never,
      },
    );
    expect(ghCalls).toHaveLength(1);
    expect(ghCalls[0]!.args[0]).toBe("123");
  });

  test("bd id with no matching record errors with exit 1", async () => {
    const errors: string[] = [];
    const exitCode = await runPlanView(
      makeOpts({ id: "ai-home-missing" }),
      { log: () => undefined, error: (l) => errors.push(l) },
      {
        execGh: (() => ghOk()) as never,
        loadBeads: (async () => [bead({ id: "ai-home-other" })]) as never,
      },
    );
    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("ai-home-missing");
  });
});

describe("runPlanView — bd loader failure (GH-1186 review)", () => {
  test("bd loader throwing returns exit 1 with bd-unreachable message", async () => {
    const errors: string[] = [];
    const exitCode = await runPlanView(
      makeOpts({ id: "ai-home-xyz" }),
      { log: () => undefined, error: (l) => errors.push(l) },
      {
        execGh: (() => ghOk()) as never,
        loadBeads: (async () => {
          throw new Error("bd: database not found");
        }) as never,
      },
    );
    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("bd unreachable");
    expect(errors[0]).toContain("bd: database not found");
  });

  test("bd record with external_ref + query/fragment resolves to GH (extractIssueNumber)", async () => {
    const ghCalls: Array<{ args: string[] }> = [];
    await runPlanView(
      makeOpts({ id: "ai-home-xyz" }),
      { log: () => undefined, error: () => undefined },
      {
        execGh: ((opts: { args: string[] }) => {
          ghCalls.push({ args: opts.args });
          return ghOk();
        }) as never,
        loadBeads: (async () => [
          bead({
            id: "ai-home-xyz",
            externalRef: "https://github.com/o/r/issues/123?source=intake",
          }),
        ]) as never,
      },
    );
    expect(ghCalls).toHaveLength(1);
    expect(ghCalls[0]!.args[0]).toBe("123");
  });
});

describe("runPlanView — notion paths (GH-874)", () => {
  test("Notion UUID dispatches to runScoutNotion and renders the result", async () => {
    const calls: Array<{ id: string }> = [];
    const logs: string[] = [];
    const exitCode = await runPlanView(
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
    expect(logs[0]).toContain("uuid:     550e8400-e29b-41d4-a716-446655440000");
  });

  test("Notion Task-ID dispatches to runScoutNotion", async () => {
    const calls: Array<{ id: string }> = [];
    await runPlanView(
      makeOpts({ id: "PROJ-5779" }),
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
    expect(calls[0]!.id).toBe("PROJ-5779");
  });

  test("Notion json output wraps result with source='notion'", async () => {
    const logs: string[] = [];
    await runPlanView(
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

describe("runPlanView — input validation", () => {
  test("empty id returns exit 1", async () => {
    const errors: string[] = [];
    const exitCode = await runPlanView(
      makeOpts({ id: "" }),
      { log: () => undefined, error: (l) => errors.push(l) },
      { execGh: (() => ghOk()) as never },
    );
    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("must not be empty");
  });

  test("shell-metachar id returns exit 1", async () => {
    const errors: string[] = [];
    const exitCode = await runPlanView(
      makeOpts({ id: "foo;rm" }),
      { log: () => undefined, error: (l) => errors.push(l) },
      { execGh: (() => ghOk()) as never },
    );
    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("invalid characters");
  });
});
