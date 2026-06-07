// tools/labels — the gh-label sync engine. The spawn is injectable, so the
// list/parse, diff-apply (create/edit/delete), error, and format paths are
// covered with a fake gh; one real (read-only) `gh label list` exercises the
// default spawn wrapper.

import { describe, expect, test } from "bun:test";

import {
  computeLabelDiff,
  formatSyncLabelsResult,
  listGhLabels,
  syncLabels,
  type GhLabel,
} from "../../src/tools/labels.ts";
import type { LabelDefinition } from "../../src/triage/labels.ts";

type SpawnResult = { status: number | null; stdout?: string; stderr?: string; error?: Error };
type Spawn = (args: string[], options: { cwd?: string | undefined }) => SpawnResult;

const okList = (labels: GhLabel[]): SpawnResult => ({ status: 0, stdout: JSON.stringify(labels) });

// Route by the gh subcommand (args = ["label", <verb>, ...]).
const router = (handlers: Partial<Record<string, () => SpawnResult>>): Spawn =>
  (args) => (handlers[args[1] ?? ""] ?? (() => ({ status: 0, stdout: "[]" })))();

const def = (name: string, description: string, color: string): LabelDefinition =>
  ({ name, description, color, axis: "test", value: name }) as unknown as LabelDefinition;
const schema = (): LabelDefinition[] => [
  def("keep", "kept", "00ff00"),
  def("drift", "new desc", "ff0000"),
  def("missing", "to create", "0000ff"),
];

// ── listGhLabels ──────────────────────────────────────────────────────────────

describe("listGhLabels", () => {
  test("parses gh label list json", () => {
    const labels = listGhLabels(undefined, undefined, (() =>
      okList([{ name: "a", description: "d", color: "fff" }])) as never);
    expect(labels).toEqual([{ name: "a", description: "d", color: "fff" }]);
  });
  test("throws on non-zero exit", () => {
    expect(() => listGhLabels("o/r", undefined, (() => ({ status: 1, stderr: "boom" })) as never)).toThrow(/boom/);
  });
  test("throws on invalid JSON", () => {
    expect(() => listGhLabels(undefined, undefined, (() => ({ status: 0, stdout: "{not json" })) as never)).toThrow(/invalid JSON/);
  });
  test("throws when the payload is not an array", () => {
    expect(() => listGhLabels(undefined, undefined, (() => ({ status: 0, stdout: "{}" })) as never)).toThrow(/expected .* an array/);
  });
});

// ── computeLabelDiff ──────────────────────────────────────────────────────────

describe("computeLabelDiff", () => {
  test("classifies creates / updates / unknown", () => {
    const existing: GhLabel[] = [
      { name: "keep", description: "kept", color: "00ff00" }, // identical → no change
      { name: "drift", description: "OLD", color: "ff0000" }, // desc drift → update
      { name: "stale", description: "x", color: "111" }, // not in schema → unknown
    ];
    const d = computeLabelDiff(schema(), existing);
    expect(d.creates.map((c) => c.name)).toEqual(["missing"]);
    expect(d.updates.map((u) => u.to.name)).toEqual(["drift"]);
    expect(d.unknown.map((u) => u.name)).toEqual(["stale"]);
  });
});

// ── syncLabels ────────────────────────────────────────────────────────────────

const existing: GhLabel[] = [
  { name: "keep", description: "kept", color: "00ff00" },
  { name: "drift", description: "OLD", color: "ff0000" },
  { name: "stale", description: "x", color: "111" },
];

describe("syncLabels", () => {
  test("dry-run computes the diff but applies nothing", () => {
    const r = syncLabels({ dryRun: true, prune: true }, {
      schema,
      spawn: router({ list: () => okList(existing) }) as never,
    });
    expect(r.dryRun).toBe(true);
    expect(r.applied).toEqual({ created: [], updated: [], deleted: [] });
    expect(r.diff.creates).toHaveLength(1);
  });

  test("apply with --prune creates, edits, and deletes", () => {
    const calls: string[][] = [];
    const spawn: Spawn = (args) => {
      calls.push(args);
      if (args[1] === "list") return okList(existing);
      return { status: 0, stdout: "" };
    };
    const r = syncLabels({ repo: "o/r", prune: true }, { schema, spawn: spawn as never });
    expect(r.applied.created).toEqual(["missing"]);
    expect(r.applied.updated).toEqual(["drift"]);
    expect(r.applied.deleted).toEqual(["stale"]);
    expect(calls.some((c) => c[1] === "create")).toBe(true);
    expect(calls.some((c) => c[1] === "edit")).toBe(true);
    expect(calls.some((c) => c[1] === "delete")).toBe(true);
  });

  test("a failed create / edit / delete throws", () => {
    const mk = (failVerb: string) =>
      syncLabels({ prune: true }, {
        schema,
        spawn: router({
          list: () => okList(existing),
          [failVerb]: () => ({ status: 1, stderr: `${failVerb} failed` }),
        }) as never,
      });
    expect(() => mk("create")).toThrow(/create failed/);
    expect(() => mk("edit")).toThrow(/edit failed/);
    expect(() => mk("delete")).toThrow(/delete failed/);
  });

  test("default spawn wrapper runs the real read-only gh label list (dry-run)", () => {
    // No injected spawn → exercises defaultSpawn via the list call. Dry-run, so
    // nothing is written even if gh is authed for the cwd's repo.
    expect(() => syncLabels({ dryRun: true, repo: "prx-nonexistent-xyz/nope" }, { schema })).toThrow();
  });
});

// ── formatSyncLabelsResult ────────────────────────────────────────────────────

describe("formatSyncLabelsResult", () => {
  const result = syncLabels({ dryRun: true, prune: true }, {
    schema,
    spawn: router({ list: () => okList(existing) }) as never,
  });

  test("json round-trips", () => {
    expect(JSON.parse(formatSyncLabelsResult(result, "json")).diff.creates).toHaveLength(1);
  });
  test("plain dry-run lists the diff", () => {
    const out = formatSyncLabelsResult(result, "plain");
    expect(out).toMatch(/dry-run/);
    expect(out).toMatch(/\+ missing/);
  });
  test("plain applied (non-dry-run) reports the applied counts", () => {
    const applied = syncLabels({ prune: true }, {
      schema,
      spawn: ((args: string[]) => (args[1] === "list" ? okList(existing) : { status: 0, stdout: "" })) as never,
    });
    expect(formatSyncLabelsResult(applied, "plain")).toMatch(/applied: created=1 updated=1 deleted=1/);
  });
});
