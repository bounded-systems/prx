// GH-1603 → GH-1649 — per-page bd writer for the fetch verb.
//
// Per row: resolve the GH issue URL → bd canonical long id (I-BF1, via
// `resolveFromBeads` over a once-loaded snapshot), create the bead if it
// is unmirrored (I-BF2, via `runIntakeMirror`), then `bd update <bdId>
// --external-ref <url> --status <s> --title <t>` with the **canonical
// long id as positional arg 0**. Writing positional is load-bearing
// (I-F7): a bare `bd update --external-ref <url>` with no positional id
// falls through bd's resolver to the "last-touched issue" fallback and
// silently miswires every unmatched row (the GH-1473 miswire class).
// Keeping `--external-ref` alongside the positional id is an idempotent
// re-link (harmless) and forward-syncs status/title for freshly-created
// beads in the same uniform step.
//
// The writer's contract is page-atomic — if any row fails (create or
// update), it throws `FetchWriteError` so the orchestrator skips
// `setWatermark` for that page (I-F4 + I-F5).
//
// `bd import` is blocked at `src/tools/bd.ts:69-71`, so per-row writes
// are not just stylistic — they're the only admitted shape.

import { processEnv } from "@bounded-systems/env";
import { execBd as defaultExecBd, type BdExecResult } from "@bounded-systems/bd";
import type { GhIssueRow } from "./gh-issues-graphql.ts";

export type BdExecRunner = typeof defaultExecBd;

/** Outcome of the create-from-external-record path (I-BF2). Mirrors the
 *  `runIntakeMirror` JSON render: a fresh create yields `createdBdId`, a
 *  resolve-race yields `existingBdId`. */
export type FetchCreateBeadResult = {
  exitCode: number;
  createdBdId?: string;
  existingBdId?: string;
};

export type FetchWriteDeps = {
  /** Injected so tests can drive the bd boundary without a real binary. */
  execBd?: BdExecRunner;
  /** Forwarded to `execBd` so the bd spawn inherits the operator env. */
  env?: NodeJS.ProcessEnv;
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
    super(
      `fetch page ${pageNumber} row ${rowIndex} bd update failed: ${stderr || "no stderr"}`,
    );
    this.name = "FetchWriteError";
    this.pageNumber = pageNumber;
    this.rowIndex = rowIndex;
    this.lastSuccessfulUpdatedAt = lastSuccessfulUpdatedAt;
    this.stderr = stderr;
  }
}

function bdStatusFromGhState(state: "OPEN" | "CLOSED"): "open" | "closed" {
  return state === "OPEN" ? "open" : "closed";
}

/**
 * Write one page of GH issue rows to bd. Per row: resolve URL→bdId
 * (I-BF1), create-if-missing (I-BF2), then one `bd update <bdId>
 * --external-ref <url> --status <s> --title <t>` call with the canonical
 * long id positional (I-F7 — never the bare `--external-ref`-only form
 * that hits bd's last-touched fallback). On any non-zero exit (create or
 * update), throws `FetchWriteError`; the orchestrator catches and skips
 * the watermark advance (I-F4: page atomicity, I-F5: monotonicity).
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
  const exec = deps.execBd ?? defaultExecBd;
  const env = deps.env ?? processEnv();

  if (rows.length === 0) {
    return {
      rowsWritten: 0,
      lastUpdatedAt: priorWatermark ?? "",
    };
  }

  let lastUpdatedAt = priorWatermark ?? "";
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;

    // I-F7 / I-BF1: resolve the issue URL to its bd canonical long id over
    // the once-loaded snapshot. A null result means the issue is not yet
    // mirrored — create it via the canonical `runIntakeMirror` path (I-BF2)
    // and write by the freshly-minted id. Either way the `bd update` below
    // gets a positional long id, never bd's last-touched fallback.
    let bdId = deps.resolveBdId ? deps.resolveBdId(row.url) : null;
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
      bdId = created.createdBdId ?? created.existingBdId ?? null;
      if (created.exitCode !== 0 || bdId === null) {
        throw new FetchWriteError(
          pageNumber,
          i,
          priorWatermark,
          `bd create (intake mirror) failed for GH-${row.number} ` +
            `(exit ${created.exitCode})`,
        );
      }
    }

    const result: BdExecResult = exec(
      {
        subcommand: "update",
        args: [
          bdId,
          "--external-ref",
          row.url,
          "--status",
          bdStatusFromGhState(row.state),
          "--title",
          row.title,
        ],
        state: "planning",
        role: "planner",
      },
      env as NodeJS.ProcessEnv,
    );
    if (result.exitCode !== 0) {
      const stderr =
        result.stderr.trim() || result.stdout.trim() || "bd update failed";
      throw new FetchWriteError(pageNumber, i, priorWatermark, stderr);
    }
    lastUpdatedAt = row.updatedAt;
  }

  return { rowsWritten: rows.length, lastUpdatedAt };
}
