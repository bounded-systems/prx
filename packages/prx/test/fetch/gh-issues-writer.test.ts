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
  type BdExecRunner,
  type FetchCreateBeadResult,
  type FetchWriteDeps,
} from "../../src/fetch/gh-issues-writer.ts";
import { execBd as realExecBd, type BdSpawnFn } from "@bounded-systems/bd";
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
function makeRecordingExecBd(
  behavior: (callIndex: number) => { status: number; stderr?: string } = () => ({
    status: 0,
  }),
): { execBd: BdExecRunner; recorded: string[][] } {
  const recorded: string[][] = [];
  const spawn: BdSpawnFn = (cmd) => {
    const idx = recorded.length;
    recorded.push([...cmd]);
    const beh = behavior(idx);
    return {
      status: beh.status,
      signal: null,
      stdout: "",
      stderr: beh.stderr ?? "",
    };
  };
  const execBd: BdExecRunner = (opts, env) => realExecBd(opts, env, spawn);
  return { execBd, recorded };
}

const updateCalls = (recorded: string[][]): string[][] =>
  recorded.filter((c) => c[0] === "bd" && c[1] === "update");

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
    const adapter = new GhDomainAdapter({ loadAllBeads: () => beads });
    const { execBd, recorded } = makeRecordingExecBd();

    const deps: FetchWriteDeps = {
      execBd,
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
      const bdId = cmd[2]!;
      // I-F7: the positional id is present and is a canonical long id —
      // not a flag, not absent (the last-touched footgun).
      expect(bdId.startsWith("-")).toBe(false);
      expect(bdId).toMatch(BD_LONG_ID_RE);
      expect(cmd[3]).toBe("--external-ref");
      const url = cmd[4]!;
      expect(bdId).toBe(expectedById[url]!);
    }
    // No update call is positional-less (cmd[2] would be a flag).
    expect(updates.some((c) => c[2]!.startsWith("-"))).toBe(false);
  });

  test("unmatched row mirrors via createBead, then writes positional `bd update <createdBdId> …` (I-BF2)", () => {
    const rows = [row(42)];
    const { execBd, recorded } = makeRecordingExecBd();
    const createCalls: Array<{ ghId: string; repo: string }> = [];

    const deps: FetchWriteDeps = {
      execBd,
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
    expect(updates[0]![2]).toBe(LONG_ID_1);
    expect(updates[0]![2]).toMatch(BD_LONG_ID_RE);
    expect(updates[0]![3]).toBe("--external-ref");
  });

  test("I-F4 — a row whose bd update exits non-zero throws FetchWriteError (no further rows, watermark not advanced)", () => {
    const rows = [row(1), row(2)];
    const beads: BeadsRecord[] = [
      bead({ id: LONG_ID_1, externalRefs: { gh: rows[0]!.url }, externalIssueNumber: 1 }),
      bead({ id: LONG_ID_2, externalRefs: { gh: rows[1]!.url }, externalIssueNumber: 2 }),
    ];
    const adapter = new GhDomainAdapter({ loadAllBeads: () => beads });
    // Second bd update (call index 1) fails.
    const { execBd, recorded } = makeRecordingExecBd((i) =>
      i === 1 ? { status: 1, stderr: "bd: connection refused" } : { status: 0 },
    );

    const deps: FetchWriteDeps = {
      execBd,
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
    const { execBd, recorded } = makeRecordingExecBd();

    const deps: FetchWriteDeps = {
      execBd,
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
