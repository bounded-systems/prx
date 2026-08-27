// GH-1649 → GH-1022 — resolve/create-mirror coverage for the fetch writer.
//
// GitHub is the write plane, so the writer no longer back-writes to bd: the
// old `prx beads update <bdId> --external-ref …` spawn was removed with the
// beads CLI (GH-1022). What remains is the per-row mirror contract: resolve
// the GH issue URL → bd canonical long id (I-BF1) over a once-loaded
// snapshot, and create-if-missing via the intake mirror seam (I-BF2). These
// tests drive the real `resolveFromBeads` and pin the page-atomic failure
// behavior (I-F4) around the create seam.

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

describe("writePage — resolve-by-URL + create-if-missing mirror", () => {
  test("already-mirrored rows resolve to their bead and are no-ops (no create)", () => {
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

    const deps: FetchWriteDeps = {
      resolveBdId: (url) => adapter.resolveFromBeads(url, beads),
      repo: "x/y",
      // createBead must never be reached — both rows resolve.
      createBead: () => {
        throw new Error("createBead should not be called for matched rows");
      },
    };

    const result = writePage(rows, 1, null, deps);
    expect(result.rowsWritten).toBe(2);
    expect(result.lastUpdatedAt).toBe(rows[1]!.updatedAt);
  });

  test("unmatched row mirrors via createBead (I-BF2)", () => {
    const rows = [row(42)];
    const createCalls: Array<{ ghId: string; repo: string }> = [];

    const deps: FetchWriteDeps = {
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
  });

  test("I-F4 — a failed createBead aborts the page (no watermark advance)", () => {
    const rows = [row(7)];

    const deps: FetchWriteDeps = {
      resolveBdId: () => null,
      repo: "x/y",
      createBead: (): FetchCreateBeadResult => ({ exitCode: 1 }),
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
    expect(e.rowIndex).toBe(0);
    // The prior watermark rides the error payload so the orchestrator can
    // skip the advance (I-F5).
    expect(e.lastSuccessfulUpdatedAt).toBe("2026-05-12T00:00:00Z");
  });
});
