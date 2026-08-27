// GH-1603 → GH-1649 → GH-1022 — per-page mirror writer for the fetch verb.
//
// Per row: resolve the GH issue URL → bd canonical long id (I-BF1, via
// `resolveFromBeads` over a once-loaded snapshot) and, if the issue is
// unmirrored (I-BF2), create the bead via `runIntakeMirror`. GitHub is the
// write plane, so there is no back-write leg: the old beads external-ref /
// status / title update spawn was removed with the beads CLI (GH-1022).
// Resolving an already-mirrored row is a no-op; an unmirrored row is
// mirrored once by the create path (which establishes the external ref).
//
// The writer's contract is page-atomic — if a row's create fails, it throws
// `FetchWriteError` so the orchestrator skips `setWatermark` for that page
// (I-F4 + I-F5).

import type { GhIssueRow } from "./gh-issues-graphql.ts";

/** Outcome of the create-from-external-record path (I-BF2). Mirrors the
 *  `runIntakeMirror` JSON render: a fresh create yields `createdBdId`, a
 *  resolve-race yields `existingBdId`. */
export type FetchCreateBeadResult = {
  exitCode: number;
  createdBdId?: string;
  existingBdId?: string;
};

export type FetchWriteDeps = {
  /**
   * Resolve a GH issue URL → bd canonical long id, or null when the issue
   * is not yet mirrored. Production = `adapter.resolveFromBeads(url, beads)`
   * over the run's once-loaded snapshot (I-BF1). The returned id matches
   * `BD_LONG_ID_RE`, so it passes the `findShortIdPositional` guard at
   * `src/tools/bd.ts:200` as positional arg 0.
   */
  resolveBdId?: (url: string) => string | null;
  /**
   * Create-from-external-record for an unmirrored row (I-BF2). Production
   * wraps `runIntakeMirror({ ghId, repo, dryRun:false, format:"json" })` and
   * parses `createdBdId ?? existingBdId` from its JSON render.
   */
  createBead?: (args: { ghId: string; repo: string }) => FetchCreateBeadResult;
  /** `owner/name` slug forwarded to `createBead`. */
  repo?: string;
};

export type WritePageResult = {
  rowsWritten: number;
  /** ISO-8601 `updatedAt` of the last row written — feeds setWatermark. */
  lastUpdatedAt: string;
};

export class FetchWriteError extends Error {
  readonly code = "FETCH_WRITE_FAILED" as const;
  readonly pageNumber: number;
  readonly rowIndex: number;
  /** Watermark target the *prior* page advanced to; null if this is page 1. */
  readonly lastSuccessfulUpdatedAt: string | null;
  readonly stderr: string;

  constructor(
    pageNumber: number,
    rowIndex: number,
    lastSuccessfulUpdatedAt: string | null,
    stderr: string,
  ) {
    super(`fetch page ${pageNumber} row ${rowIndex} mirror failed: ${stderr || "no stderr"}`);
    this.name = "FetchWriteError";
    this.pageNumber = pageNumber;
    this.rowIndex = rowIndex;
    this.lastSuccessfulUpdatedAt = lastSuccessfulUpdatedAt;
    this.stderr = stderr;
  }
}

/**
 * Mirror one page of GH issue rows into beads. Per row: resolve URL→bdId
 * (I-BF1) and create-if-missing (I-BF2). GitHub is the write plane, so
 * there is no back-write leg — an already-mirrored row is a no-op. On a
 * failed create, throws `FetchWriteError`; the orchestrator catches and
 * skips the watermark advance (I-F4: page atomicity, I-F5: monotonicity).
 *
 * `pageNumber` and `priorWatermark` only influence the error payload —
 * the writer itself is stateless across pages.
 */
export function writePage(
  rows: GhIssueRow[],
  pageNumber: number,
  priorWatermark: string | null,
  deps: FetchWriteDeps = {},
): WritePageResult {
  if (rows.length === 0) {
    return {
      rowsWritten: 0,
      lastUpdatedAt: priorWatermark ?? "",
    };
  }

  let lastUpdatedAt = priorWatermark ?? "";
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;

    // I-BF1: resolve the issue URL to its bd canonical long id over the
    // once-loaded snapshot. A null result means the issue is not yet
    // mirrored — create it via the canonical `runIntakeMirror` path (I-BF2).
    // An already-resolved row is a no-op (GitHub is the write plane).
    const bdId = deps.resolveBdId ? deps.resolveBdId(row.url) : null;
    if (bdId === null) {
      if (!deps.createBead || deps.repo === undefined) {
        throw new FetchWriteError(
          pageNumber,
          i,
          priorWatermark,
          `writer misconfigured: row ${row.number} (${row.url}) is unmirrored ` +
            `but no createBead/repo seam was provided`,
        );
      }
      const created = deps.createBead({
        ghId: `GH-${row.number}`,
        repo: deps.repo,
      });
      const createdId = created.createdBdId ?? created.existingBdId ?? null;
      if (created.exitCode !== 0 || createdId === null) {
        throw new FetchWriteError(
          pageNumber,
          i,
          priorWatermark,
          `bd create (intake mirror) failed for GH-${row.number} ` + `(exit ${created.exitCode})`,
        );
      }
    }

    lastUpdatedAt = row.updatedAt;
  }

  return { rowsWritten: rows.length, lastUpdatedAt };
}
