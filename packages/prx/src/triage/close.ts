// `prx triage close <bd-id>` (GH-1719) — actor-tied close for bd-only
// records (open bd records with no `external_ref` linking them to a GH
// issue). Resolves the *lower* half of the reverse-orphan lifecycle
// (bd-only → closed); the *upper* half (bd-only → published-to-GH) lives
// in `prx beads publish` (GH-1507). The prior `triage push-orphans`
// sweep covering the upper half was retired in GH-1718.
//
// Direction is the explicitly sanctioned exception under
// `feedback_actor_tied_tool_invocations`: operators were previously closing
// bd-only junk records via raw `bd update -s closed`. This verb routes that
// shape through a planner-tier `prx <actor> <verb>` wrapper so the actor-tied
// directive holds. `bd close` itself remains hard-blocked at the wrapper
// layer (`src/tools/bd.ts:BLOCKED_SUBCOMMANDS`); the close transition is
// achieved via `bd update -s closed`, which the policy table already permits
// for the planner role.
//
// Refusal rules:
//   - Bead not found       — refuse.
//   - Bead has external_ref — refuse and point at `prx plan close GH-N`.
//   - Bead already closed   — refuse (idempotency).
//
// `--dry-run` describes the planned action without writing. `--note`
// concatenates after the reason prefix in the bd-side note. `--reason`
// defaults to `not-planned` and shares vocabulary with `prx plan close`.

import { z } from "zod";

import type { BeadsRecord } from "./triage.ts";
// GH-296 wave 2: read + close through beadsd (one true source), not local bd.
// A single-id close is a targeted `show <id>` + daemon close, not a load-all.
import { showBeadViaDaemon } from "../beadsd/reads.ts";
import { closeBeadViaDaemon } from "../beadsd/writes.ts";

export const triageCloseReasonSchema = z.enum(["completed", "not-planned", "duplicate"]);
export type TriageCloseReason = z.infer<typeof triageCloseReasonSchema>;

export const triageCloseOptionsSchema = z.object({
  bdId: z.string().trim().min(1),
  reason: triageCloseReasonSchema.default("not-planned"),
  note: z.string().trim().min(1).optional(),
  dryRun: z.boolean().default(false),
  format: z.enum(["plain", "json"]).default("plain"),
});
export type TriageCloseOptions = z.infer<typeof triageCloseOptionsSchema>;

export type TriageCloseResult = {
  bdId: string;
  reason: TriageCloseReason;
  closed: boolean;
  dryRun: boolean;
  refusalReason: string | null;
  note: string | null;
};

export type TriageCloseDeps = {
  /** Targeted daemon read (default {@link showBeadViaDaemon}). */
  showBead?: (id: string) => Promise<BeadsRecord | null>;
  /** Daemon close (default {@link closeBeadViaDaemon}). */
  closeBead?: (id: string, reason?: string) => Promise<BeadsRecord | null>;
  invalidateBeadsCache?: () => void;
};

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

// Shared by `prx triage close` and `prx triage close-stale` (GH-1782) so the
// reason-axis vocabulary and note shape drift together. `verb` is the
// operator-visible verb name embedded in the prefix.
export function buildClosedNotePrefixed(
  verb: string,
  reason: TriageCloseReason,
  note: string | undefined,
): string {
  const prefix = `closed via ${verb} (reason=${reason})`;
  return note ? `${prefix}: ${note}` : prefix;
}

export function buildCloseNote(reason: TriageCloseReason, note: string | undefined): string {
  return buildClosedNotePrefixed("prx triage close", reason, note);
}

export async function runTriageClose(
  opts: TriageCloseOptions,
  output: Output,
  deps: TriageCloseDeps = {},
): Promise<TriageCloseResult> {
  const showBead = deps.showBead ?? showBeadViaDaemon;
  const closeBead = deps.closeBead ?? closeBeadViaDaemon;
  const note = opts.note ?? null;

  let record: BeadsRecord | null;
  try {
    record = await showBead(opts.bdId);
  } catch (err) {
    const message = (err as Error).message;
    output.error(`triage close: ${message}`);
    return {
      bdId: opts.bdId,
      reason: opts.reason,
      closed: false,
      dryRun: opts.dryRun,
      refusalReason: message,
      note,
    };
  }

  if (!record) {
    const refusalReason = `bd record '${opts.bdId}' not found`;
    output.error(`triage close: ${refusalReason}`);
    return {
      bdId: opts.bdId,
      reason: opts.reason,
      closed: false,
      dryRun: opts.dryRun,
      refusalReason,
      note,
    };
  }

  if (record.externalRef !== null) {
    const refusalReason =
      `bd record '${opts.bdId}' is GH-linked (→ ${record.externalRef}); ` +
      `use \`prx plan close GH-N --reason ${opts.reason}\` instead`;
    output.error(`triage close: ${refusalReason}`);
    return {
      bdId: opts.bdId,
      reason: opts.reason,
      closed: false,
      dryRun: opts.dryRun,
      refusalReason,
      note,
    };
  }

  if (record.status === "closed") {
    const refusalReason = `bd record '${opts.bdId}' is already closed`;
    output.error(`triage close: ${refusalReason}`);
    return {
      bdId: opts.bdId,
      reason: opts.reason,
      closed: false,
      dryRun: opts.dryRun,
      refusalReason,
      note,
    };
  }

  const noteBody = buildCloseNote(opts.reason, opts.note);

  if (opts.dryRun) {
    output.log(
      `dry-run ${opts.bdId} close (reason=${opts.reason}) note="${noteBody}"`,
    );
    return {
      bdId: opts.bdId,
      reason: opts.reason,
      closed: false,
      dryRun: true,
      refusalReason: null,
      note,
    };
  }

  try {
    // The daemon maps close → `bd update <id> --status closed --notes <reason>`;
    // we pass the composed note body as the reason.
    await closeBead(opts.bdId, noteBody);
  } catch (err) {
    const detail = (err as Error).message;
    output.error(`triage close: bd update failed for ${opts.bdId}: ${detail}`);
    return {
      bdId: opts.bdId,
      reason: opts.reason,
      closed: false,
      dryRun: false,
      refusalReason: detail,
      note,
    };
  }

  deps.invalidateBeadsCache?.();
  output.log(`closed ${opts.bdId} (reason=${opts.reason})`);
  return {
    bdId: opts.bdId,
    reason: opts.reason,
    closed: true,
    dryRun: false,
    refusalReason: null,
    note,
  };
}

export function formatTriageCloseResult(
  result: TriageCloseResult,
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  if (result.refusalReason) {
    return `refused ${result.bdId}: ${result.refusalReason}`;
  }
  if (result.dryRun) {
    return `dry-run ${result.bdId} close (reason=${result.reason})`;
  }
  return `closed ${result.bdId} (reason=${result.reason})`;
}
