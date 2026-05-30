// GH-1275 (PR-3 of GH-1261): classification matrix for diffSnapshots.
//
// Exercises every DepClassification enum value plus added/removed/modified
// changes per axis, plus the precedence rule (schema > state > cli > config >
// breaking). Pure: no fixtures, no IO.

import { describe, expect, test } from "bun:test";

import { diffSnapshots } from "../../src/dep-research/diff.ts";
import type {
  DepClassificationHints,
  DepSnapshot,
} from "../../src/dep-research/schemas.ts";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function snap(opts: {
  dep?: string;
  runId?: string;
  shas: Record<string, string>;
}): DepSnapshot {
  const sourceShas = opts.shas;
  const byteLen: Record<string, number> = {};
  for (const path of Object.keys(sourceShas)) byteLen[path] = 1;
  return {
    dep: opts.dep ?? "x",
    run_id: opts.runId ?? "20260101T000000Z",
    fetched_at: "2026-01-01T00:00:00.000Z",
    source_sha256: sourceShas,
    source_byte_len: byteLen,
    run_state: "ok",
  };
}

const emptyHints: DepClassificationHints = {
  schema: [],
  state: [],
  cli: [],
  config: [],
};

describe("diffSnapshots — change detection", () => {
  test("identical snapshots produce classification: none", () => {
    const prev = snap({ shas: { "a.ts": SHA_A } });
    const curr = snap({ shas: { "a.ts": SHA_A }, runId: "20260102T000000Z" });
    const delta = diffSnapshots(prev, curr, emptyHints);
    expect(delta.classification).toBe("none");
    expect(delta.changes).toEqual([]);
    expect(delta.prev_run_id).toBe("20260101T000000Z");
    expect(delta.curr_run_id).toBe("20260102T000000Z");
  });

  test("first run (prev=null) flags every path as added", () => {
    const curr = snap({ shas: { "schema.sql": SHA_A, "main.go": SHA_B } });
    const delta = diffSnapshots(null, curr, emptyHints);
    expect(delta.prev_run_id).toBeNull();
    const kinds = delta.changes.map((c) => c.kind).sort();
    expect(kinds).toEqual(["added", "added"]);
  });

  test("modified path detected on sha mismatch", () => {
    const prev = snap({ shas: { "a.ts": SHA_A } });
    const curr = snap({ shas: { "a.ts": SHA_B }, runId: "20260102T000000Z" });
    const delta = diffSnapshots(prev, curr, emptyHints);
    expect(delta.changes).toEqual([{ path: "a.ts", kind: "modified", excerpt: "" }]);
  });

  test("removed path detected on key drop", () => {
    const prev = snap({ shas: { "kept.ts": SHA_A, "gone.ts": SHA_B } });
    const curr = snap({ shas: { "kept.ts": SHA_A }, runId: "20260102T000000Z" });
    const delta = diffSnapshots(prev, curr, emptyHints);
    expect(delta.changes).toEqual([{ path: "gone.ts", kind: "removed", excerpt: "" }]);
  });

  test("excerpt is empty on PR-3 (filled by PR-4)", () => {
    const prev = snap({ shas: { "a.ts": SHA_A } });
    const curr = snap({ shas: { "a.ts": SHA_B }, runId: "20260102T000000Z" });
    const delta = diffSnapshots(prev, curr, emptyHints);
    for (const c of delta.changes) expect(c.excerpt).toBe("");
  });
});

describe("diffSnapshots — classification matrix (per axis)", () => {
  test("schema: path matches schema regex => classification 'schema'", () => {
    const prev = snap({ shas: { "schema.sql": SHA_A } });
    const curr = snap({ shas: { "schema.sql": SHA_B }, runId: "20260102T000000Z" });
    const delta = diffSnapshots(prev, curr, {
      ...emptyHints,
      schema: ["schema\\.sql$"],
    });
    expect(delta.classification).toBe("schema");
  });

  test("state: path matches state regex => classification 'state'", () => {
    const prev = snap({ shas: { "State.ts": SHA_A } });
    const curr = snap({ shas: { "State.ts": SHA_B }, runId: "20260102T000000Z" });
    const delta = diffSnapshots(prev, curr, {
      ...emptyHints,
      state: ["State(Node)?\\.ts$"],
    });
    expect(delta.classification).toBe("state");
  });

  test("cli: path matches cli regex => classification 'cli'", () => {
    const prev = snap({ shas: { "cmd/bd/main.go": SHA_A } });
    const curr = snap({
      shas: { "cmd/bd/main.go": SHA_B },
      runId: "20260102T000000Z",
    });
    const delta = diffSnapshots(prev, curr, {
      ...emptyHints,
      cli: ["cmd/bd/.*\\.go$"],
    });
    expect(delta.classification).toBe("cli");
  });

  test("config: path matches config regex => classification 'config'", () => {
    const prev = snap({ shas: { "docs/CONFIG.md": SHA_A } });
    const curr = snap({
      shas: { "docs/CONFIG.md": SHA_B },
      runId: "20260102T000000Z",
    });
    const delta = diffSnapshots(prev, curr, {
      ...emptyHints,
      config: ["docs/CONFIG\\.md$"],
    });
    expect(delta.classification).toBe("config");
  });

  test("breaking: path matches no axis => classification 'breaking'", () => {
    const prev = snap({ shas: { "unmapped/file.go": SHA_A } });
    const curr = snap({
      shas: { "unmapped/file.go": SHA_B },
      runId: "20260102T000000Z",
    });
    const delta = diffSnapshots(prev, curr, emptyHints);
    expect(delta.classification).toBe("breaking");
  });

  test("none: no changes between snapshots => classification 'none'", () => {
    const prev = snap({ shas: { "x": SHA_A } });
    const curr = snap({ shas: { "x": SHA_A }, runId: "20260102T000000Z" });
    const delta = diffSnapshots(prev, curr, {
      schema: ["x"],
      state: [],
      cli: [],
      config: [],
    });
    expect(delta.classification).toBe("none");
  });
});

describe("diffSnapshots — axis precedence", () => {
  test("schema beats state when both regexes hit different changed paths", () => {
    const prev = snap({
      shas: { "types.ts": SHA_A, "State.ts": SHA_B },
    });
    const curr = snap({
      shas: { "types.ts": SHA_C, "State.ts": SHA_C },
      runId: "20260102T000000Z",
    });
    const delta = diffSnapshots(prev, curr, {
      schema: ["types\\.ts$"],
      state: ["State\\.ts$"],
      cli: [],
      config: [],
    });
    expect(delta.classification).toBe("schema");
  });

  test("state beats cli when both regexes hit different changed paths", () => {
    const prev = snap({
      shas: { "State.ts": SHA_A, "cli.go": SHA_B },
    });
    const curr = snap({
      shas: { "State.ts": SHA_C, "cli.go": SHA_C },
      runId: "20260102T000000Z",
    });
    const delta = diffSnapshots(prev, curr, {
      schema: [],
      state: ["State\\.ts$"],
      cli: ["cli\\.go$"],
      config: [],
    });
    expect(delta.classification).toBe("state");
  });

  test("cli beats config when both regexes hit different changed paths", () => {
    const prev = snap({
      shas: { "main.go": SHA_A, "CONFIG.md": SHA_B },
    });
    const curr = snap({
      shas: { "main.go": SHA_C, "CONFIG.md": SHA_C },
      runId: "20260102T000000Z",
    });
    const delta = diffSnapshots(prev, curr, {
      schema: [],
      state: [],
      cli: ["main\\.go$"],
      config: ["CONFIG\\.md$"],
    });
    expect(delta.classification).toBe("cli");
  });

  test("config beats breaking — unmapped path sits under config-axis hit", () => {
    const prev = snap({
      shas: { "CONFIG.md": SHA_A, "ungrouped.txt": SHA_B },
    });
    const curr = snap({
      shas: { "CONFIG.md": SHA_C, "ungrouped.txt": SHA_C },
      runId: "20260102T000000Z",
    });
    const delta = diffSnapshots(prev, curr, {
      schema: [],
      state: [],
      cli: [],
      config: ["CONFIG\\.md$"],
    });
    expect(delta.classification).toBe("config");
  });

  test("when first regex in an axis matches, axis wins (multi-pattern)", () => {
    const prev = snap({ shas: { "types.ts": SHA_A } });
    const curr = snap({ shas: { "types.ts": SHA_B }, runId: "20260102T000000Z" });
    const delta = diffSnapshots(prev, curr, {
      schema: ["never\\.matches", "types\\.ts$"],
      state: [],
      cli: [],
      config: [],
    });
    expect(delta.classification).toBe("schema");
  });
});

describe("diffSnapshots — Zod boundary", () => {
  test("output round-trips through DepDelta.parse", () => {
    const curr = snap({ shas: { "a.ts": SHA_A } });
    const delta = diffSnapshots(null, curr, emptyHints);
    // diffSnapshots itself runs DepDelta.parse, so the call returning here
    // is the round-trip assertion. Spot-check the shape.
    expect(delta.dep).toBe("x");
    expect(delta.curr_run_id).toBe("20260101T000000Z");
    expect(delta.changes.length).toBe(1);
  });
});
