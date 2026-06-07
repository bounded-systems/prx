import { describe, expect, test } from "bun:test";

import {
  formatPlanSearchRender,
  planSearchOptionsSchema,
  runPlanSearch,
  type PlanSearchOptions,
} from "../../src/plan-store/plan-search.ts";
import type { GhExecResult } from "@bounded-systems/gh";
import type { BeadsRecord } from "../../src/triage/triage.ts";

function makeOpts(overrides: Partial<PlanSearchOptions> = {}): PlanSearchOptions {
  return {
    query: "plan",
    state: "all",
    source: "both",
    limit: 20,
    format: "plain",
    ...overrides,
  };
}

type GhListEntry = {
  number: number;
  title: string;
  state: string;
  url: string;
  labels?: Array<{ name: string }>;
};

function ghList(entries: GhListEntry[]): GhExecResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify(entries),
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

describe("runPlanSearch — GH paths", async () => {
  test("invokes gh issue list with --search/--state/--limit/--json", async () => {
    const calls: Array<{ group: string; subcommand: string; args: string[] }> = [];
    await runPlanSearch(
      makeOpts({ query: "plan session", state: "open", limit: 50 }),
      { log: () => undefined, error: () => undefined },
      {
        execGh: ((opts: { group: string; subcommand: string; args: string[] }) => {
          calls.push(opts);
          return ghList([]);
        }) as never,
        loadBeads: (async () => []) as never,
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.group).toBe("issue");
    expect(calls[0]!.subcommand).toBe("list");
    expect(calls[0]!.args[calls[0]!.args.indexOf("--search") + 1]).toBe("plan session");
    expect(calls[0]!.args[calls[0]!.args.indexOf("--state") + 1]).toBe("open");
    expect(calls[0]!.args[calls[0]!.args.indexOf("--limit") + 1]).toBe("50");
    expect(calls[0]!.args).toContain("--json");
  });

  test("--source beads skips the gh call entirely", async () => {
    let ghCalls = 0;
    await runPlanSearch(
      makeOpts({ query: "plan", source: "beads" }),
      { log: () => undefined, error: () => undefined },
      {
        execGh: (() => {
          ghCalls++;
          return ghList([]);
        }) as never,
        loadBeads: (async () => []) as never,
      },
    );
    expect(ghCalls).toBe(0);
  });

  test("--source gh skips the bd loader entirely", async () => {
    let bdCalls = 0;
    await runPlanSearch(
      makeOpts({ query: "plan", source: "gh" }),
      { log: () => undefined, error: () => undefined },
      {
        execGh: (() =>
          ghList([
            { number: 1, title: "plan thing", state: "OPEN", url: "u/1" },
          ])) as never,
        loadBeads: (async () => {
          bdCalls++;
          return [];
        }) as never,
      },
    );
    expect(bdCalls).toBe(0);
  });

  test("propagates gh exit code on failure", async () => {
    const errors: string[] = [];
    const exitCode = await runPlanSearch(
      makeOpts(),
      { log: () => undefined, error: (l) => errors.push(l) },
      {
        execGh: (() => ghFail("gh: rate-limited", 2)) as never,
        loadBeads: (async () => []) as never,
      },
    );
    expect(exitCode).toBe(2);
    expect(errors[0]).toContain("gh: rate-limited");
  });
});

describe("runPlanSearch — dedupe by external_ref", async () => {
  test("collapses GH+bd pairs into a single hit with source='both'", async () => {
    const logs: string[] = [];
    await runPlanSearch(
      makeOpts({ query: "plan", format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        execGh: (() =>
          ghList([
            {
              number: 1186,
              title: "plan view + search",
              state: "OPEN",
              url: "https://github.com/o/r/issues/1186",
            },
          ])) as never,
        loadBeads: (async () => [
          bead({
            id: "ai-home-aaa",
            title: "plan view + search",
            externalRef: "https://github.com/o/r/issues/1186",
            externalIssueNumber: 1186,
          }),
        ]) as never,
      },
    );
    const parsed = JSON.parse(logs[0]!) as {
      hits: Array<{ id: string; source: string; beadId?: string }>;
    };
    expect(parsed.hits).toHaveLength(1);
    expect(parsed.hits[0]!.id).toBe("GH-1186");
    expect(parsed.hits[0]!.source).toBe("both");
    expect(parsed.hits[0]!.beadId).toBe("ai-home-aaa");
  });

  test("matches by issue number when bd record lacks external_ref but has externalIssueNumber", async () => {
    const logs: string[] = [];
    await runPlanSearch(
      makeOpts({ query: "plan", format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        execGh: (() =>
          ghList([
            {
              number: 7,
              title: "plan thing",
              state: "OPEN",
              url: "https://github.com/o/r/issues/7",
            },
          ])) as never,
        loadBeads: (async () => [
          bead({
            id: "ai-home-bbb",
            title: "plan thing",
            externalRef: "https://github.com/o/r/issues/7",
            externalIssueNumber: 7,
          }),
        ]) as never,
      },
    );
    const parsed = JSON.parse(logs[0]!) as {
      hits: Array<{ source: string; beadId?: string }>;
    };
    expect(parsed.hits[0]!.source).toBe("both");
    expect(parsed.hits[0]!.beadId).toBe("ai-home-bbb");
  });

  test("bd-only hits (no matching GH search hit) pass through with source='bd'", async () => {
    const logs: string[] = [];
    await runPlanSearch(
      makeOpts({ query: "alpha", format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        execGh: (() => ghList([])) as never,
        loadBeads: (async () => [
          bead({ id: "ai-home-ccc", title: "alpha-only thing" }),
        ]) as never,
      },
    );
    const parsed = JSON.parse(logs[0]!) as {
      hits: Array<{ id: string; source: string }>;
    };
    expect(parsed.hits).toHaveLength(1);
    expect(parsed.hits[0]!.id).toBe("ai-home-ccc");
    expect(parsed.hits[0]!.source).toBe("bd");
  });

  test("GH-only hits (no bd record claims the URL) pass through with source='gh'", async () => {
    const logs: string[] = [];
    await runPlanSearch(
      makeOpts({ query: "lonely", format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        execGh: (() =>
          ghList([
            { number: 99, title: "lonely gh", state: "OPEN", url: "u/99" },
          ])) as never,
        loadBeads: (async () => [
          bead({ id: "ai-home-ddd", title: "unrelated" }),
        ]) as never,
      },
    );
    const parsed = JSON.parse(logs[0]!) as {
      hits: Array<{ id: string; source: string }>;
    };
    expect(parsed.hits).toHaveLength(1);
    expect(parsed.hits[0]!.id).toBe("GH-99");
    expect(parsed.hits[0]!.source).toBe("gh");
  });
});

describe("runPlanSearch — graceful degradation", async () => {
  test("bd unreachable warns once and continues with GH-only results", async () => {
    const errors: string[] = [];
    const logs: string[] = [];
    const exitCode = await runPlanSearch(
      makeOpts({ query: "plan" }),
      { log: (l) => logs.push(l), error: (l) => errors.push(l) },
      {
        execGh: (() =>
          ghList([
            { number: 1, title: "plan", state: "OPEN", url: "u/1" },
          ])) as never,
        loadBeads: (async () => {
          throw new Error("bd: database not found");
        }) as never,
      },
    );
    expect(exitCode).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("bd unreachable");
    expect(errors[0]).toContain("bd: database not found");
    expect(errors[0]).toContain("continuing with GH-only");
    expect(logs[0]).toContain("GH-1");
  });

  // (Removed: "bd list exits non-zero but emits a valid array" — that tolerance
  // lived in the local `loadAllBeads`; under the daemon (server-mode dolt) the
  // post-listing push-rejection that produced it cannot occur, and the daemon
  // owns the parse. The bd-unreachable → GH-only path below still covers errors.)

  test("bd unreachable with --source beads warns 'no results' (no GH fallback)", async () => {
    const errors: string[] = [];
    const exitCode = await runPlanSearch(
      makeOpts({ query: "plan", source: "beads" }),
      { log: () => undefined, error: (l) => errors.push(l) },
      {
        execGh: (() => ghList([])) as never,
        loadBeads: (async () => {
          throw new Error("bd: database not found");
        }) as never,
      },
    );
    expect(exitCode).toBe(0);
    expect(errors[0]).toContain("bd unreachable");
    expect(errors[0]).toContain("no results returned");
    expect(errors[0]).not.toContain("GH-only");
  });

  test("--state closed filters bd records by status (GH-1186 review)", async () => {
    const logs: string[] = [];
    await runPlanSearch(
      makeOpts({ query: "plan", state: "closed", source: "beads", format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        execGh: (() => ghList([])) as never,
        loadBeads: (async () => [
          bead({ id: "ai-home-open", title: "plan one", status: "open" }),
          bead({ id: "ai-home-closed", title: "plan two", status: "closed" }),
        ]) as never,
      },
    );
    const parsed = JSON.parse(logs[0]!) as {
      hits: Array<{ id: string; state: string }>;
    };
    expect(parsed.hits).toHaveLength(1);
    expect(parsed.hits[0]!.id).toBe("ai-home-closed");
  });

  test("plain output emits no-hits notice when both sources empty", async () => {
    const logs: string[] = [];
    await runPlanSearch(
      makeOpts({ query: "nonsense-xyzzy" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        execGh: (() => ghList([])) as never,
        loadBeads: (async () => []) as never,
      },
    );
    expect(logs[0]).toContain("no hits");
    expect(logs[0]).toContain("nonsense-xyzzy");
  });
});

describe("planSearchOptionsSchema", async () => {
  test("rejects empty query", async () => {
    expect(() => planSearchOptionsSchema.parse({ query: "" })).toThrow();
    expect(() => planSearchOptionsSchema.parse({ query: "   " })).toThrow();
  });

  test("defaults state=all, source=both, limit=20, format=plain", async () => {
    const parsed = planSearchOptionsSchema.parse({ query: "x" });
    expect(parsed.state).toBe("all");
    expect(parsed.source).toBe("both");
    expect(parsed.limit).toBe(20);
    expect(parsed.format).toBe("plain");
  });

  test("rejects invalid state", async () => {
    expect(() =>
      planSearchOptionsSchema.parse({ query: "x", state: "bogus" }),
    ).toThrow();
  });

  test("rejects invalid source", async () => {
    expect(() =>
      planSearchOptionsSchema.parse({ query: "x", source: "notion" }),
    ).toThrow();
  });
});

describe("formatPlanSearchRender", async () => {
  test("plain render with hits shows id/state/source/bd-id/title columns", async () => {
    const out = formatPlanSearchRender(
      {
        query: "q",
        state: "all",
        source: "both",
        hits: [
          {
            id: "GH-1",
            state: "OPEN",
            title: "t1",
            source: "both",
            beadId: "ai-home-aaaa",
            url: "u1",
          },
          { id: "ai-home-bbbb", state: "open", title: "t2", source: "bd" },
        ],
      },
      "plain",
    );
    const lines = out.split("\n");
    expect(lines[0]).toContain("id");
    expect(lines[0]).toContain("bd-id");
    expect(lines[0]).toContain("title");
    expect(lines[1]).toContain("GH-1");
    expect(lines[1]).toContain("ai-home-aaaa");
    expect(lines[2]).toContain("ai-home-bbbb");
  });

  test("json render is well-formed JSON with the full envelope", async () => {
    const out = formatPlanSearchRender(
      { query: "q", state: "all", source: "both", hits: [] },
      "json",
    );
    expect(JSON.parse(out)).toEqual({
      query: "q",
      state: "all",
      source: "both",
      hits: [],
    });
  });
});
