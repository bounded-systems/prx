/**
 * `prx plan view <id>` — read primitive for the plan operator session
 * (GH-1186, planner-side twin of `prx intake view`). Accepts GH-N / #N /
 * bare integer / GitHub URL / work-item id and prints title + state +
 * labels + body + comments through the same `src/issues/` core.
 *
 * Pure read; sits upstream of the parity chain; emits no XState events,
 * touches no schema. Same shape as `runIntakeView`. GH-1012 removed the
 * bd + Notion (scout) arms: the write plane is GitHub and the read plane
 * is Front Desk. Non-gh ids resolve through {@link showBeadViaDaemon}
 * (Front Desk) and, when carrying a GH external ref, fall through to the
 * GitHub view; the resolver's Notion arm now returns an error.
 */

import { z } from "zod";

import { extractIssueNumber } from "../issues/dedupe.ts";
import { IssueResolveError, resolveIssueId, type IssueResolvedId } from "../issues/resolver.ts";
import { formatIssueViewRender, viewGhIssue, type IssueViewRender } from "../issues/render.ts";
import { execGh } from "@bounded-systems/gh";
import type { BeadsRecord } from "../triage/triage.ts";
// GH-296/GH-1012: targeted work-item read through Front Desk (the read plane),
// not local bd. A single-id view is `show <id>`, not load-the-world-and-`.find()`.
import { showBeadViaDaemon } from "../beads/frontdesk-reads.ts";

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
  /** GH-296/GH-1012: Front-Desk targeted read (default {@link showBeadViaDaemon}). */
  showBead?: (id: string) => Promise<BeadsRecord | null>;
};

const VERB = "prx plan view";

export async function runPlanView(
  opts: PlanViewOptions,
  output: Output,
  deps: PlanViewDeps = {},
): Promise<number> {
  const ghExec = deps.execGh ?? execGh;
  const showBead = deps.showBead ?? showBeadViaDaemon;

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
      // GH-1012: the Notion adapter (scout/notion) is gone; Notion ids no
      // longer resolve through plan view.
      output.error(`${VERB}: Notion ids are no longer supported`);
      return 1;
    }

    let record;
    try {
      record = await showBead(resolved.id);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      output.error(`${VERB}: Front Desk unreachable: ${detail}`);
      return 1;
    }
    if (!record) {
      output.error(`${VERB}: no record matching '${resolved.id}'`);
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
