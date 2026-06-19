/**
 * `prx plan view <id>` — read primitive for the plan operator session
 * (GH-1186, planner-side twin of `prx intake view`). Accepts GH-N / #N /
 * bare integer / GitHub URL / Notion UUID / Notion Task-ID / bd id and
 * prints title + state + labels + body + comments through the same
 * `src/issues/` core.
 *
 * Pure read; sits upstream of the parity chain; emits no XState events,
 * touches no schema. Same shape as `runIntakeView`. GH-874 extended the
 * resolver to a 3-arm discriminated union (gh | notion | bd); the Notion
 * arm dispatches through `runScoutNotion` so plan-view returns
 * `Promise<number>`.
 */

import { z } from "zod";

import { extractIssueNumber } from "../issues/dedupe.ts";
import { IssueResolveError, resolveIssueId, type IssueResolvedId } from "../issues/resolver.ts";
import { formatIssueViewRender, viewGhIssue, type IssueViewRender } from "../issues/render.ts";
import { runScoutNotion, ScoutNotionError } from "../scout/notion.ts";
import { execBd } from "@bounded-systems/bd";
import { execGh } from "@bounded-systems/gh";
import type { BeadsRecord } from "../triage/triage.ts";
// GH-296: targeted beads read through the daemon (one true source), not local
// bd. A single-id view is `show <id>`, not load-the-world-and-`.find()`.
import { showBeadViaDaemon } from "../beadsd/reads.ts";

export const planViewOptionsSchema = z.object({
  id: z.string().trim().min(1, "id must not be empty"),
  format: z.enum(["plain", "json"]).default("plain"),
});

export type PlanViewOptions = z.infer<typeof planViewOptionsSchema>;

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

export type PlanViewDeps = {
  execGh?: typeof execGh;
  execBd?: typeof execBd;
  /** GH-296: daemon-routed targeted read (default {@link showBeadViaDaemon}). */
  showBead?: (id: string) => Promise<BeadsRecord | null>;
  runScoutNotion?: typeof runScoutNotion;
};

const VERB = "prx plan view";

export async function runPlanView(
  opts: PlanViewOptions,
  output: Output,
  deps: PlanViewDeps = {},
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
      output.log(renderPlanView({ source: "gh", payload }, opts.format));
      return 0;
    }

    if (resolved.kind === "notion") {
      try {
        const result = await scoutNotion({
          id: resolved.id.value,
          ghExec,
          bdExec,
        });
        output.log(renderPlanView({ source: "notion", payload: result }, opts.format));
        return 0;
      } catch (err) {
        if (err instanceof ScoutNotionError) {
          output.error(`${VERB}: ${err.message}`);
          return 1;
        }
        throw err;
      }
    }

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
      output.log(renderPlanView({ source: "gh", payload }, opts.format));
      return 0;
    }
    output.log(renderPlanView({ source: "bd", payload: record }, opts.format));
    return 0;
  } catch (err) {
    if (err instanceof IssueResolveError) {
      output.error(err.message);
      return err.exitCode;
    }
    throw err;
  }
}

export function renderPlanView(render: IssueViewRender, format: "plain" | "json"): string {
  return formatIssueViewRender(render, format);
}
