/**
 * `prx intake view <id>` — read primitive for the intake operator session
 * (GH-1000, part of GH-998). Accepts GH-N / #N / bare integer / GitHub URL /
 * Notion UUID / Notion Task-ID / bd id and prints title + state + labels +
 * body + comments.
 *
 * Mirrors src/intake/intake.ts: pure read, sits upstream of the parity chain,
 * emits no XState events, no schema scaffolding.
 *
 * GH-1186 extracted the shared GH/bd payload + renderers into
 * `src/issues/render.ts`; this file is now a thin actor-binding plus
 * back-compat re-exports for existing callers and tests. GH-874 added a
 * Notion arm that dispatches through `runScoutNotion`; `runIntakeView`
 * therefore returns `Promise<number>`.
 */

import { z } from "zod";

import { extractIssueNumber } from "../issues/dedupe.ts";
import {
  IssueResolveError,
  resolveIssueId,
  type IssueResolvedId,
} from "../issues/resolver.ts";
import {
  formatIssueViewRender,
  viewGhIssue,
  type IssueViewRender,
} from "../issues/render.ts";
import { runScoutNotion, ScoutNotionError } from "../scout/notion.ts";
import { execBd } from "@bounded-systems/bd";
import { execGh } from "@bounded-systems/gh";
import type { BeadsRecord } from "../triage/triage.ts";
// GH-296: targeted beads read through the daemon (one true source), not local
// bd. A single-id view is `show <id>`, not load-the-world-and-`.find()`.
import { showBeadViaDaemon } from "../beadsd/reads.ts";

export {
  IntakeViewError,
  resolveIntakeViewId,
  type IntakeViewResolvedId,
} from "./intake-id.ts";
export type { GhIssueViewPayload } from "../issues/render.ts";

export const intakeViewOptionsSchema = z.object({
  id: z.string().trim().min(1, "id must not be empty"),
  format: z.enum(["plain", "json"]).default("plain"),
});

export type IntakeViewOptions = z.infer<typeof intakeViewOptionsSchema>;

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

export type IntakeViewRender = IssueViewRender;

export type IntakeViewDeps = {
  execGh?: typeof execGh;
  execBd?: typeof execBd;
  /** GH-296: daemon-routed targeted read (default {@link showBeadViaDaemon}). */
  showBead?: (id: string) => Promise<BeadsRecord | null>;
  runScoutNotion?: typeof runScoutNotion;
};

const VERB = "prx intake view";

export async function runIntakeView(
  opts: IntakeViewOptions,
  output: Output,
  deps: IntakeViewDeps = {},
): Promise<number> {
  const ghExec = deps.execGh ?? execGh;
  const showBead = deps.showBead ?? showBeadViaDaemon;
  const bdExec = deps.execBd ?? execBd;
  const scoutNotion = deps.runScoutNotion ?? runScoutNotion;

  let resolved: IssueResolvedId;
  try {
    resolved = resolveIssueId(opts.id, VERB);
  } catch (err) {
    if (err instanceof IssueResolveError) {
      output.error(err.message);
      return err.exitCode;
    }
    throw err;
  }

  try {
    if (resolved.kind === "gh") {
      const payload = viewGhIssue(resolved, ghExec, VERB);
      output.log(formatIntakeViewRender({ source: "gh", payload }, opts.format));
      return 0;
    }

    if (resolved.kind === "notion") {
      try {
        const result = await scoutNotion({
          id: resolved.id.value,
          ghExec,
          bdExec,
        });
        output.log(
          formatIntakeViewRender(
            { source: "notion", payload: result },
            opts.format,
          ),
        );
        return 0;
      } catch (err) {
        if (err instanceof ScoutNotionError) {
          output.error(`${VERB}: ${err.message}`);
          return 1;
        }
        throw err;
      }
    }

    // bd resolution path (best-effort per acceptance): a targeted `show <id>`.
    let record;
    try {
      record = await showBead(resolved.id);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      output.error(`${VERB}: bd unreachable: ${detail}`);
      return 1;
    }
    if (!record) {
      output.error(`${VERB}: no bd record matching '${resolved.id}'`);
      return 1;
    }
    const refNumber = extractIssueNumber(record.externalRef);
    if (refNumber !== null) {
      const payload = viewGhIssue({ number: refNumber }, ghExec, VERB);
      output.log(formatIntakeViewRender({ source: "gh", payload }, opts.format));
      return 0;
    }
    output.log(formatIntakeViewRender({ source: "bd", payload: record }, opts.format));
    return 0;
  } catch (err) {
    if (err instanceof IssueResolveError) {
      output.error(err.message);
      return err.exitCode;
    }
    throw err;
  }
}

export function formatIntakeViewRender(
  render: IntakeViewRender,
  format: "plain" | "json",
): string {
  return formatIssueViewRender(render, format);
}
