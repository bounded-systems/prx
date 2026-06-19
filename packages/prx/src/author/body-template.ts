/**
 * `prx author body-template` (GH-1206).
 *
 * Pure-data renderer for the CLAUDE.md PR Standards run-sheet body. Takes a
 * `--unit <id>` (GH-N / #N / bare integer / GitHub URL / bd id), resolves it
 * through `resolveIssueId`, and emits markdown the operator pastes into
 * `gh pr create --body-file` (or `gh pr edit --body-file`).
 *
 * The 5-item run-sheet template is lifted verbatim from CLAUDE.md "Pull
 * Request Standards" — each item is rendered with an annotation slot the
 * operator fills in before marking the PR ready for review.
 *
 * Sibling of `src/submit/body-template.ts`: this renderer reuses
 * `renderBodyTemplate` for both `Closes #N` and `Refs <id>` lines (GH-1805
 * unified the convention across kinds) so id-resolution and per-kind
 * formatting stay in one place. The author-only addition is the bd-only
 * `## Post-merge handoff` block (GH-1773).
 */

import { z } from "zod";

import { resolveIssueId, IssueResolveError } from "../issues/resolver.ts";
import { renderBodyTemplate } from "../submit/body-template.ts";

export const authorBodyTemplateOptionsSchema = z.object({
  unit: z.string().trim().min(1),
  base: z.string().default("origin/main"),
  format: z.enum(["plain", "json"]).default("plain"),
});

export type AuthorBodyTemplateOptions = z.infer<typeof authorBodyTemplateOptionsSchema>;

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

export type AuthorBodyRender = {
  /** Summary heading placeholder for the operator to fill in. */
  summaryPlaceholder: string;
  /** 5-item CLAUDE.md run-sheet, items unchecked with annotation slots. */
  runSheet: string[];
  /** `Closes #N` lines (empty for bd-only units). */
  closesLines: string[];
  /** `Refs <bd-id>` line (empty for GH-only units). */
  refsLine: string;
  /**
   * `## Post-merge handoff` section — populated for bd-only units to remind
   * the operator that `prx submit postmerge` is the close-loop owner (since
   * GitHub's auto-close keywords do not fire on `Refs <bd-id>`). Empty for
   * GH-numbered units, where merge triggers GH's projection directly.
   */
  postMergeHandoff: string;
  /** Resolved unit kind — surfaced in JSON output for callers. */
  unitKind: "gh" | "bd" | "notion";
};

export class AuthorBodyTemplateError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "AuthorBodyTemplateError";
    this.exitCode = exitCode;
  }
}

const RUN_SHEET_ITEMS: ReadonlyArray<readonly [string, string]> = [
  ["Independent PR", "no bundled or speculative changes — confirm scope here"],
  ["Changed codepaths verified", "targeted unit + integration test names"],
  ["Root cause identified", "every failure traced to source"],
  ["No duplication", "refactoring preferred over copy/paste"],
  ["No unrelated changes", "housekeeping isolated to its own branch"],
];

export function renderAuthorBody(opts: AuthorBodyTemplateOptions): AuthorBodyRender {
  let resolved;
  try {
    resolved = resolveIssueId(opts.unit, "prx author body-template");
  } catch (err) {
    if (err instanceof IssueResolveError) {
      throw new AuthorBodyTemplateError(err.message, err.exitCode);
    }
    throw err;
  }

  const runSheet = RUN_SHEET_ITEMS.map(([item, annotation]) => `- [ ] **${item}** — ${annotation}`);

  const summaryPlaceholder = "## Summary\n\n<one-paragraph summary of the change and why>";

  // GH-1805: submit's `renderBodyTemplate` now emits the same Closes/Refs
  // convention for all three kinds (GH-N → `Closes #N`; bd/notion → `Refs
  // <id>`), so author can reuse it directly instead of mirroring the
  // per-kind branching. The author-only concern below is the bd-only
  // post-merge handoff reminder (GH-1773), which submit doesn't render.
  const render = renderBodyTemplate({
    closes: [opts.unit],
    format: "plain",
  });
  const closesLines = render.closesLines;
  const refsLine = render.refsLines[0] ?? "";

  let postMergeHandoff = "";
  if (resolved.kind === "bd") {
    // GH-1773: name the close-loop owner in the body so the operator sees
    // the handoff responsibility at PR-author time. `prx submit postmerge`
    // sweeps merged PR bodies and runs `bd close <bd-id>` for any matching
    // `Refs <bd-id>` line; if postmerge does not run, the bd record stays
    // open per docs/architecture/bd-canonical-pr-linkage.md §2.
    postMergeHandoff = [
      "## Post-merge handoff",
      "",
      `After merge, \`prx submit postmerge <pr>\` will run \`bd close ${resolved.id}\`. If postmerge does not run, close the bd record manually.`,
    ].join("\n");
  }

  return {
    summaryPlaceholder,
    runSheet,
    closesLines,
    refsLine,
    postMergeHandoff,
    unitKind: resolved.kind,
  };
}

export function formatAuthorBodyRender(render: AuthorBodyRender, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(render, null, 2);
  }
  const sections: string[] = [];
  sections.push(render.summaryPlaceholder);
  sections.push(["## Run-sheet", "", ...render.runSheet].join("\n"));
  if (render.closesLines.length > 0) {
    sections.push(render.closesLines.join("\n"));
  }
  if (render.refsLine.length > 0) {
    sections.push(render.refsLine);
  }
  if (render.postMergeHandoff.length > 0) {
    sections.push(render.postMergeHandoff);
  }
  return sections.join("\n\n");
}

export function runAuthorBodyTemplate(opts: AuthorBodyTemplateOptions, output: Output): number {
  let render: AuthorBodyRender;
  try {
    render = renderAuthorBody(opts);
  } catch (err) {
    if (err instanceof AuthorBodyTemplateError) {
      output.error(err.message);
      return err.exitCode;
    }
    throw err;
  }
  output.log(formatAuthorBodyRender(render, opts.format));
  return 0;
}
