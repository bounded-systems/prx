// GH-1649 — real-`execBd` argv-pinned coverage for the fetch writer.
//
// The GH-1603 writer emitted `bd update --external-ref <url> …` with NO
// positional id; against a real bd binary an unmatched row falls through
// bd's resolver to the "last-touched issue" fallback and silently
// miswires (the GH-1473 class). These tests drive the **real** `execBd`
// (only its `spawn` seam is injected) so the policy table + the
// `findShortIdPositional` guard at `src/tools/bd.ts:200` are exercised,
// and pin the argv crossing the bd boundary: the resolved canonical long
// id must sit at positional index 2 (`bd update <bdId> …`), never as a
// flag and never absent (I-F7).

import { describe, expect, test } from "bun:test";

import {
  writePage,
  FetchWriteError,
  type FetchCreateBeadResult,
  type FetchWriteDeps,
} from "../../src/fetch/gh-issues-writer.ts";
import { GhDomainAdapter } from "../../src/adapters/github.ts";
import type { BeadsRecord } from "../../src/triage/triage.ts";
import type { GhIssueRow } from "../../src/fetch/gh-issues-graphql.ts";

// Mirror of `BD_LONG_ID_RE` in src/tools/bd.ts — the writer must hand bd a
// canonical long id (workspace-prefixed ts-seq-hex8), which the structural
// guard admits as positional arg 0.
const BD_LONG_ID_RE = /^[a-z][a-z0-9-]*-\d{13,}-\d+-[0-9a-f]{8}$/i;

const LONG_ID_1 = "ai-home-1700000000001-1-deadbeef";
const LONG_ID_2 = "ai-home-1700000000002-7-0badf00d";

function bead(overrides: Partial<BeadsRecord> & { id: string }): BeadsRecord {
  return {
    title: "",
    description: "",
    status: "open",
    priority: null,
    issueType: "task",
    externalRef: null,
    externalRefs: {},
    metadata: null,
    externalIssueNumber: null,
    sourceSystem: null,
    ...overrides,
  };
}

function row(n: number, overrides: Partial<GhIssueRow> = {}): GhIssueRow {
  return {
    number: n,
    url: `https://github.com/x/y/issues/${n}`,
    updatedAt: `2026-05-13T1${n}:00:00Z`,
    state: "OPEN",
    title: `row-${n}`,
    ...overrides,
  };
}

/**
 * The injected `spawn` seam: records every bd argv and returns a
 * configurable exit (default success). Wrapping the real `execBd` with it
 * exercises the actual policy + short-id guard without a live bd binary.
 */
// GH-296 / prx-82b: the writer's bd update now runs `prx beads update …` through
// the daemon (a sync runner). This records every prx argv and returns a
// configurable exit, so the argv-shape pins (positional id placement) still hold.
function makeRecordingRun(
  behavior: (callIndex: number) => { status: number; stderr?: string } = () => ({
    status: 0,
  }),
): {
  run: (
    cmd: string[],
    o?: { check?: boolean },
  ) => { status: number; stdout: string; stderr: string };
  recorded: string[][];
} {
  const recorded: string[][] = [];
  const run = (cmd: string[]) => {
    const idx = recorded.length;
    recorded.push([...cmd]);
    const beh = behavior(idx);
    return { status: beh.status, stdout: "", stderr: beh.stderr ?? "" };
  };
  return { run, recorded };
}

const updateCalls = (recorded: string[][]): string[][] =>
  recorded.filter((c) => c[0] === "prx" && c[1] === "beads" && c[2] === "update");

describe("writePage — resolve-by-URL + positional-id write (I-F7)", () => {
  test("matched rows write `bd update <canonical-long-id> --external-ref …` — id at positional index 2, never last-touched", () => {
    const rows = [row(1), row(2)];
    const beads: BeadsRecord[] = [
      bead({
        id: LONG_ID_1,
        externalRefs: { gh: rows[0]!.url },
        externalIssueNumber: 1,
      }),
      bead({
        id: LONG_ID_2,
        externalRefs: { gh: rows[1]!.url },
        externalIssueNumber: 2,
      }),
    ];
    // Drive the *real* resolver seam, not a stub.
    const adapter = new GhDomainAdapter();
    const { run, recorded } = makeRecordingRun();

    const deps: FetchWriteDeps = {
      run,
      resolveBdId: (url) => adapter.resolveFromBeads(url, beads),
      repo: "x/y",
      // createBead must never be reached — both rows resolve.
      createBead: () => {
        throw new Error("createBead should not be called for matched rows");
      },
    };

    const result = writePage(rows, 1, null, deps);
    expect(result.rowsWritten).toBe(2);

    const updates = updateCalls(recorded);
    expect(updates).toHaveLength(2);

    // Per-row: cmd = ["bd","update",<bdId>,"--external-ref",<url>,…].
    const expectedById: Record<string, string> = {
      [rows[0]!.url]: LONG_ID_1,
      [rows[1]!.url]: LONG_ID_2,
    };
    for (const cmd of updates) {
      // cmd = ["prx","beads","update",<bdId>,"--external-ref",<url>,…].
      const bdId = cmd[3]!;
      // I-F7: the positional id is present and is a canonical long id —
      // not a flag, not absent (the last-touched footgun).
      expect(bdId.startsWith("-")).toBe(false);
      expect(bdId).toMatch(BD_LONG_ID_RE);
      expect(cmd[4]).toBe("--external-ref");
      const url = cmd[5]!;
      expect(bdId).toBe(expectedById[url]!);
    }
    // No update call is positional-less (cmd[3] would be a flag).
    expect(updates.some((c) => c[3]!.startsWith("-"))).toBe(false);
  });

  test("unmatched row mirrors via createBead, then writes positional `bd update <createdBdId> …` (I-BF2)", () => {
    const rows = [row(42)];
    const { run, recorded } = makeRecordingRun();
    const createCalls: Array<{ ghId: string; repo: string }> = [];

    const deps: FetchWriteDeps = {
      run,
      // Empty snapshot ⇒ resolver returns null ⇒ create path.
      resolveBdId: () => null,
      repo: "x/y",
      createBead: (args): FetchCreateBeadResult => {
        createCalls.push(args);
        return { exitCode: 0, createdBdId: LONG_ID_1 };
      },
    };

    const result = writePage(rows, 1, null, deps);
    expect(result.rowsWritten).toBe(1);

    // Mirror invoked with the GH-form surface id + repo.
    expect(createCalls).toEqual([{ ghId: "GH-42", repo: "x/y" }]);

    const updates = updateCalls(recorded);
    expect(updates).toHaveLength(1);
    expect(updates[0]![3]).toBe(LONG_ID_1);
    expect(updates[0]![3]).toMatch(BD_LONG_ID_RE);
    expect(updates[0]![4]).toBe("--external-ref");
  });

  test("I-F4 — a row whose bd update exits non-zero throws FetchWriteError (no further rows, watermark not advanced)", () => {
    const rows = [row(1), row(2)];
    const beads: BeadsRecord[] = [
      bead({ id: LONG_ID_1, externalRefs: { gh: rows[0]!.url }, externalIssueNumber: 1 }),
      bead({ id: LONG_ID_2, externalRefs: { gh: rows[1]!.url }, externalIssueNumber: 2 }),
    ];
    const adapter = new GhDomainAdapter();
    // Second bd update (call index 1) fails.
    const { run, recorded } = makeRecordingRun((i) =>
      i === 1 ? { status: 1, stderr: "bd: connection refused" } : { status: 0 },
    );

    const deps: FetchWriteDeps = {
      run,
      resolveBdId: (url) => adapter.resolveFromBeads(url, beads),
      repo: "x/y",
    };

    let caught: unknown = null;
    try {
      writePage(rows, 3, "2026-05-12T00:00:00Z", deps);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FetchWriteError);
    const e = caught as FetchWriteError;
    expect(e.pageNumber).toBe(3);
    expect(e.rowIndex).toBe(1);
    // The prior watermark rides the error payload so the orchestrator can
    // skip the advance (I-F5).
    expect(e.lastSuccessfulUpdatedAt).toBe("2026-05-12T00:00:00Z");
    // Both rows attempted exactly one update each (no third call after the
    // failure).
    expect(updateCalls(recorded)).toHaveLength(2);
  });

  test("I-F4 — a failed createBead aborts the page before any bd update for that row", () => {
    const rows = [row(7)];
    const { run, recorded } = makeRecordingRun();

    const deps: FetchWriteDeps = {
      run,
      resolveBdId: () => null,
      repo: "x/y",
      createBead: (): FetchCreateBeadResult => ({ exitCode: 1 }),
    };

    let caught: unknown = null;
    try {
      writePage(rows, 1, null, deps);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FetchWriteError);
    // No `bd update` was issued — the create failed first.
    expect(updateCalls(recorded)).toHaveLength(0);
  });
});
