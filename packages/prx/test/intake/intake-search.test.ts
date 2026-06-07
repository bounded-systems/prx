import { describe, expect, test } from "bun:test";
import {
  formatIntakeSearchRender,
  intakeSearchOptionsSchema,
  runIntakeSearch,
  type IntakeSearchOptions,
} from "../../src/intake/intake-search.ts";
import type { GhExecResult } from "@bounded-systems/gh";
import type { BeadsRecord } from "../../src/triage/triage.ts";

function makeOpts(overrides: Partial<IntakeSearchOptions> = {}): IntakeSearchOptions {
  return { query: "intake search", state: "all", format: "plain", ...overrides };
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

describe("runIntakeSearch — GH paths", async () => {
  test("invokes gh issue list with --search/--state/--limit/--json", async () => {
    const calls: Array<{ group: string; subcommand: string; args: string[] }> = [];
    const exitCode = await runIntakeSearch(
      makeOpts({ query: "ship search", state: "open" }),
      { log: () => undefined, error: () => undefined },
      {
        execGh: ((opts: { group: string; subcommand: string; args: string[] }) => {
          calls.push(opts);
          return ghList([]);
        }) as never,
        loadBeads: (async () => []) as never,
      },
    );
    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.group).toBe("issue");
    expect(calls[0]!.subcommand).toBe("list");
    expect(calls[0]!.args).toContain("--search");
    expect(calls[0]!.args[calls[0]!.args.indexOf("--search") + 1]).toBe("ship search");
    expect(calls[0]!.args).toContain("--state");
    expect(calls[0]!.args[calls[0]!.args.indexOf("--state") + 1]).toBe("open");
    expect(calls[0]!.args).toContain("--limit");
    expect(calls[0]!.args[calls[0]!.args.indexOf("--limit") + 1]).toBe("20");
    expect(calls[0]!.args).toContain("--json");
  });

  test("plain output renders a unified id/state/source/bd-id/title table", async () => {
    const logs: string[] = [];
    await runIntakeSearch(
      makeOpts({ query: "intake", format: "plain" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        execGh: (() =>
          ghList([
            {
              number: 999,
              title: "task(prx): add prx intake search",
              state: "OPEN",
              url: "https://github.com/o/r/issues/999",
            },
          ])) as never,
        loadBeads: (async () => []) as never,
      },
    );
    expect(logs).toHaveLength(1);
    const out = logs[0]!;
    expect(out).toContain("id");
    expect(out).toContain("state");
    expect(out).toContain("source");
    expect(out).toContain("bd-id");
    expect(out).toContain("title");
    expect(out).toContain("GH-999");
    expect(out).toContain("OPEN");
    expect(out).toContain("gh");
    expect(out).toContain("task(prx): add prx intake search");
  });

  test("json output wraps hits with query/state envelope", async () => {
    const logs: string[] = [];
    await runIntakeSearch(
      makeOpts({ query: "intake", state: "open", format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        execGh: (() =>
          ghList([
            {
              number: 999,
              title: "t",
              state: "OPEN",
              url: "https://github.com/o/r/issues/999",
            },
          ])) as never,
        loadBeads: (async () => []) as never,
      },
    );
    const parsed = JSON.parse(logs[0]!) as {
      query: string;
      state: string;
      hits: Array<{ id: string; source: string; url?: string }>;
    };
    expect(parsed.query).toBe("intake");
    expect(parsed.state).toBe("open");
    expect(parsed.hits).toHaveLength(1);
    expect(parsed.hits[0]!.id).toBe("GH-999");
    expect(parsed.hits[0]!.source).toBe("gh");
    expect(parsed.hits[0]!.url).toBe("https://github.com/o/r/issues/999");
  });

  test("propagates gh exit code on failure with stderr message", async () => {
    const errors: string[] = [];
    const exitCode = await runIntakeSearch(
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

describe("runIntakeSearch — bd paths", async () => {
  test("bd hits append to gh hits, filtered by case-insensitive title substring", async () => {
    const logs: string[] = [];
    await runIntakeSearch(
      makeOpts({ query: "INTAKE" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        execGh: (() =>
          ghList([
            { number: 999, title: "intake search", state: "OPEN", url: "u/999" },
          ])) as never,
        loadBeads: (async () => [
          bead({ id: "ai-home-aaa", title: "intake matches lowercase needle" }),
          bead({ id: "ai-home-bbb", title: "unrelated" }),
        ]) as never,
      },
    );
    const out = logs[0]!;
    expect(out).toContain("GH-999");
    expect(out).toContain("ai-home-aaa");
    expect(out).not.toContain("ai-home-bbb");
  });

  test("bd unreachable warns once and continues with GH-only results", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const exitCode = await runIntakeSearch(
      makeOpts({ query: "intake" }),
      { log: (l) => logs.push(l), error: (l) => errors.push(l) },
      {
        execGh: (() =>
          ghList([
            { number: 999, title: "intake search", state: "OPEN", url: "u/999" },
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
    expect(errors[0]).toContain("GH-only");
    expect(logs[0]).toContain("GH-999");
  });

  // (Removed: "bd list exits non-zero but emits a valid array" — that tolerance
  // lived in the local `loadAllBeads`; the daemon (server-mode dolt) owns the
  // parse now and the post-listing push-rejection can't occur. bd-unreachable →
  // GH-only is still covered above.)

  test("bd json output sets source='bd' and omits url", async () => {
    const logs: string[] = [];
    await runIntakeSearch(
      makeOpts({ query: "bd-only", format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        execGh: (() => ghList([])) as never,
        loadBeads: (async () => [
          bead({ id: "ai-home-aaa", title: "bd-only thing" }),
        ]) as never,
      },
    );
    const parsed = JSON.parse(logs[0]!) as {
      hits: Array<{ id: string; source: string; url?: string }>;
    };
    expect(parsed.hits).toHaveLength(1);
    expect(parsed.hits[0]!.id).toBe("ai-home-aaa");
    expect(parsed.hits[0]!.source).toBe("bd");
    expect(parsed.hits[0]!.url).toBeUndefined();
  });
});

describe("runIntakeSearch — dedupe by external_ref", async () => {
  test("collapses GH+bd pairs sharing externalRef URL into a single source='both' row with beadId", async () => {
    const logs: string[] = [];
    await runIntakeSearch(
      makeOpts({ query: "intake", format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        execGh: (() =>
          ghList([
            {
              number: 1759,
              title: "epic(prx): operationalize GH-1754",
              state: "OPEN",
              url: "https://github.com/o/r/issues/1759",
            },
          ])) as never,
        loadBeads: (async () => [
          bead({
            id: "ai-home-gs15d",
            title: "epic(prx): operationalize GH-1754",
            externalRef: "https://github.com/o/r/issues/1759",
            externalIssueNumber: 1759,
          }),
        ]) as never,
      },
    );
    const parsed = JSON.parse(logs[0]!) as {
      hits: Array<{ id: string; source: string; beadId?: string }>;
    };
    expect(parsed.hits).toHaveLength(1);
    expect(parsed.hits[0]!.id).toBe("GH-1759");
    expect(parsed.hits[0]!.source).toBe("both");
    expect(parsed.hits[0]!.beadId).toBe("ai-home-gs15d");
  });

  test("merged row surfaces bd-id in plain output column", async () => {
    const logs: string[] = [];
    await runIntakeSearch(
      makeOpts({ query: "intake", format: "plain" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        execGh: (() =>
          ghList([
            {
              number: 1759,
              title: "intake thing",
              state: "OPEN",
              url: "https://github.com/o/r/issues/1759",
            },
          ])) as never,
        loadBeads: (async () => [
          bead({
            id: "ai-home-gs15d",
            title: "intake thing",
            externalRef: "https://github.com/o/r/issues/1759",
            externalIssueNumber: 1759,
          }),
        ]) as never,
      },
    );
    const out = logs[0]!;
    expect(out).toContain("GH-1759");
    expect(out).toContain("both");
    expect(out).toContain("ai-home-gs15d");
  });

  test("no duplicate row when the same issue is in both sources", async () => {
    const logs: string[] = [];
    await runIntakeSearch(
      makeOpts({ query: "intake", format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        execGh: (() =>
          ghList([
            {
              number: 1759,
              title: "intake thing",
              state: "OPEN",
              url: "https://github.com/o/r/issues/1759",
            },
          ])) as never,
        loadBeads: (async () => [
          bead({
            id: "ai-home-gs15d",
            title: "intake thing",
            externalRef: "https://github.com/o/r/issues/1759",
            externalIssueNumber: 1759,
          }),
        ]) as never,
      },
    );
    const parsed = JSON.parse(logs[0]!) as {
      hits: Array<{ id: string; source: string }>;
    };
    expect(parsed.hits).toHaveLength(1);
    expect(parsed.hits.filter((h) => h.id === "ai-home-gs15d")).toHaveLength(0);
  });
});

describe("runIntakeSearch — empty hits", async () => {
  test("plain output emits a no-hits notice", async () => {
    const logs: string[] = [];
    await runIntakeSearch(
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

  test("json output emits an empty hits array", async () => {
    const logs: string[] = [];
    await runIntakeSearch(
      makeOpts({ query: "nonsense-xyzzy", format: "json" }),
      { log: (l) => logs.push(l), error: () => undefined },
      {
        execGh: (() => ghList([])) as never,
        loadBeads: (async () => []) as never,
      },
    );
    const parsed = JSON.parse(logs[0]!) as { hits: unknown[] };
    expect(parsed.hits).toEqual([]);
  });
});

describe("intakeSearchOptionsSchema", async () => {
  test("rejects empty query", async () => {
    expect(() => intakeSearchOptionsSchema.parse({ query: "" })).toThrow();
    expect(() => intakeSearchOptionsSchema.parse({ query: "   " })).toThrow();
  });

  test("defaults state=all and format=plain", async () => {
    const parsed = intakeSearchOptionsSchema.parse({ query: "x" });
    expect(parsed.state).toBe("all");
    expect(parsed.format).toBe("plain");
  });

  test("rejects invalid state", async () => {
    expect(() =>
      intakeSearchOptionsSchema.parse({ query: "x", state: "bogus" }),
    ).toThrow();
  });
});

describe("formatIntakeSearchRender", async () => {
  test("plain render with hits column-aligns id/state/source/bd-id/title", async () => {
    const out = formatIntakeSearchRender(
      {
        query: "q",
        state: "all",
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
    const out = formatIntakeSearchRender(
      { query: "q", state: "all", hits: [] },
      "json",
    );
    expect(JSON.parse(out)).toEqual({ query: "q", state: "all", hits: [] });
  });
});
