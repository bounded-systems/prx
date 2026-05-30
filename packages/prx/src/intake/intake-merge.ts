/**
 * `prx intake merge <dup> <canonical>` — pointer-comment + close (GH-1001,
 * part of GH-998). Replaces the raw `gh issue comment <n>` + `gh issue close
 * <n>` pair operators run by hand during dedupe; GH-1004 has now dropped
 * `Bash(gh issue comment:*)` (and the rest of the raw `gh:*` / `bd:*` /
 * `git:*` surface) from the intake profile allowlist and denies them at the
 * Claude `--disallowedTools` flag layer, so this verb is the *only* way to
 * comment-and-close a duplicate from inside an intake session.
 *
 * After GH-1710 (canonical-bd conversion) and GH-1913, both positionals may
 * be bd-side ids. The bd↔bd arm uses `loadAllBeads` for the preflight,
 * `notes-append.ts` for the pointer-comment leg, and `execBdIssueClose` (the
 * narrow `bd close` wrapper from `src/tools/bd_issue_close.ts`) for the
 * close leg. Mixed-backend pairs (one bd, one gh) are out of scope — refused
 * with a hint.
 *
 * Mirrors src/intake/intake-view.ts and src/intake/intake-search.ts: pure
 * upstream-of-parity-chain CLI plumbing, no XState events, no schema
 * scaffolding. The verb is *not* atomic — it is comment-then-close with
 * documented partial-recovery semantics on close failure.
 */

import { processEnv } from "@bounded-systems/env";
import { z } from "zod";

import {
  IssueResolveError,
  resolveIssueId,
  type IssueResolvedId,
} from "../issues/resolver.ts";
import { execBd, type BdExecResult } from "@bounded-systems/bd";
import {
  execBdIssueClose,
  buildBdIssueCloseArgs,
  type BdIssueCloseResult,
} from "../tools/bd_issue_close.ts";
import { execGh, type GhExecResult } from "@bounded-systems/gh";
import {
  buildGhIssueCloseArgs,
  execGhIssueClose,
  type GhIssueCloseResult,
  type GhIssueCloseStateReason,
} from "../tools/gh_issue_close.ts";
import { loadAllBeads } from "../triage/triage.ts";
import {
  buildNotesAppendMarker,
  composeAppendedNotes,
  notesAlreadyContains,
} from "./notes-append.ts";

const STATE_REASONS = ["completed", "not planned", "duplicate"] as const;

export const intakeMergeOptionsSchema = z.object({
  dupId: z.string().trim().min(1, "dup id must not be empty"),
  canonicalId: z.string().trim().min(1, "canonical id must not be empty"),
  template: z.string().default("Merging into #${canonical}"),
  reason: z.enum(STATE_REASONS).default("duplicate"),
  label: z.string().optional(),
  repo: z.string().optional(),
  dryRun: z.boolean().default(false),
  format: z.enum(["plain", "json"]).default("plain"),
});

export type IntakeMergeOptions = z.infer<typeof intakeMergeOptionsSchema>;

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

export type IntakeMergeRender =
  | {
      backend: "gh";
      dupNumber: number;
      canonicalNumber: number;
      repo?: string | undefined;
      preflight: {
        argv: string[];
        closed: boolean;
        pointerSeen: boolean;
        skipped: boolean;
      };
      comment: { argv: string[]; body: string };
      close: { argv: string[]; reason: GhIssueCloseStateReason };
      label?: { argv: string[]; name: string } | undefined;
      dryRun: boolean;
      exitCode: number;
    }
  | {
      backend: "bd";
      dupId: string;
      canonicalId: string;
      marker: string;
      body: string;
      bdUpdateArgv: string[];
      bdCloseArgv: string[];
      reason: string;
      alreadyClosed: boolean;
      pointerAlreadyPresent: boolean;
      dryRun: boolean;
      exitCode: number;
    };

export type IntakeMergeDeps = {
  execGh?: typeof execGh;
  execGhIssueClose?: typeof execGhIssueClose;
  execBd?: typeof execBd;
  execBdIssueClose?: typeof execBdIssueClose;
  loadAllBeads?: typeof loadAllBeads;
};

export class IntakeMergeError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "IntakeMergeError";
    this.exitCode = exitCode;
  }
}

const VERB = "prx intake merge";

function composeGhComment(template: string, canonicalNumber: number): string {
  return template.replaceAll("${canonical}", String(canonicalNumber));
}

function buildIssueViewArgs(
  dupNumber: number,
  repo: string | undefined,
): string[] {
  const args: string[] = [String(dupNumber), "--json", "state,comments"];
  if (repo) {
    args.push("--repo", repo);
  }
  return args;
}

type PreflightView = {
  state: "OPEN" | "CLOSED";
  comments: Array<{ body: string }>;
};

function parsePreflightView(stdout: string): PreflightView | null {
  try {
    const raw = JSON.parse(stdout) as unknown;
    if (!raw || typeof raw !== "object") return null;
    const obj = raw as { state?: unknown; comments?: unknown };
    const state =
      obj.state === "OPEN" || obj.state === "CLOSED" ? obj.state : null;
    if (!state) return null;
    const comments: Array<{ body: string }> = [];
    if (Array.isArray(obj.comments)) {
      for (const c of obj.comments) {
        if (c && typeof c === "object" && typeof (c as { body?: unknown }).body === "string") {
          comments.push({ body: (c as { body: string }).body });
        }
      }
    }
    return { state, comments };
  } catch {
    return null;
  }
}

function buildCommentArgs(
  dupNumber: number,
  body: string,
  repo: string | undefined,
): string[] {
  const args: string[] = [String(dupNumber), "--body", body];
  if (repo) {
    args.push("--repo", repo);
  }
  return args;
}

function buildBdUpdateArgs(bdId: string, newNotes: string): string[] {
  return [bdId, "--notes", newNotes];
}

function buildLabelEditArgs(
  dupNumber: number,
  label: string,
  repo: string | undefined,
): string[] {
  const args: string[] = [String(dupNumber), "--add-label", label];
  if (repo) {
    args.push("--repo", repo);
  }
  return args;
}

function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  if (/^[A-Za-z0-9_/.:@=+\-#]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function renderGhArgvLine(args: string[]): string {
  return `gh ${args.map(shellQuote).join(" ")}`;
}

function renderBdArgvLine(args: string[]): string {
  return `bd ${args.map(shellQuote).join(" ")}`;
}

export function runIntakeMerge(
  opts: IntakeMergeOptions,
  output: Output,
  deps: IntakeMergeDeps = {},
): number {
  const ghExec = deps.execGh ?? execGh;
  const ghClose = deps.execGhIssueClose ?? execGhIssueClose;
  const bdExec = deps.execBd ?? execBd;
  const bdClose = deps.execBdIssueClose ?? execBdIssueClose;
  const loader = deps.loadAllBeads ?? loadAllBeads;

  let dup: IssueResolvedId;
  let canonical: IssueResolvedId;
  try {
    dup = resolveIssueId(opts.dupId, `${VERB}: dup id`);
    canonical = resolveIssueId(opts.canonicalId, `${VERB}: canonical id`);
  } catch (err) {
    if (err instanceof IssueResolveError) {
      output.error(err.message);
      return err.exitCode;
    }
    throw err;
  }

  if (dup.kind === "notion" || canonical.kind === "notion") {
    output.error(
      `${VERB}: Notion ids are read-only via 'prx scout notion'; merge into a bd or GH canonical instead`,
    );
    return 1;
  }

  if (dup.kind !== canonical.kind) {
    output.error(
      `${VERB}: cross-backend merge is out of scope (got ${dup.kind} dup + ${canonical.kind} canonical); use a same-backend pair (both GH-N or both bd ids)`,
    );
    return 1;
  }

  if (dup.kind === "gh" && canonical.kind === "gh") {
    return runGhMerge(
      opts,
      output,
      { number: dup.number, repo: dup.repo },
      { number: canonical.number, repo: canonical.repo },
      ghExec,
      ghClose,
    );
  }

  if (dup.kind === "bd" && canonical.kind === "bd") {
    if (opts.label !== undefined) {
      output.error(
        `${VERB}: --label is GH-only (bd has no label flag on 'bd update'); drop the flag on the bd arm`,
      );
      return 1;
    }
    return runBdMerge(opts, output, dup.id, canonical.id, bdExec, bdClose, loader);
  }

  // Unreachable: notion was refused, kind-mismatch was refused, leaving only
  // (gh, gh) and (bd, bd) above.
  throw new Error(`${VERB}: unreachable dispatch (dup=${dup.kind}, canonical=${canonical.kind})`);
}

function runGhMerge(
  opts: IntakeMergeOptions,
  output: Output,
  dup: { number: number; repo?: string | undefined },
  canonical: { number: number; repo?: string | undefined },
  ghExec: typeof execGh,
  ghClose: typeof execGhIssueClose,
): number {
  // Repo precedence: explicit --repo wins; otherwise the URL form on either
  // arg supplies it (dup first, then canonical). When neither, gh uses the
  // cwd's git remote.
  const repo = opts.repo ?? dup.repo ?? canonical.repo;

  const commentBody = composeGhComment(opts.template, canonical.number);
  const commentArgs = buildCommentArgs(dup.number, commentBody, repo);
  const viewArgs = buildIssueViewArgs(dup.number, repo);
  const closeArgs = buildGhIssueCloseArgs({
    number: dup.number,
    reason: opts.reason,
    repo,
  });
  const labelArgs = opts.label
    ? buildLabelEditArgs(dup.number, opts.label, repo)
    : null;

  if (opts.dryRun) {
    const render: IntakeMergeRender = {
      backend: "gh",
      dupNumber: dup.number,
      canonicalNumber: canonical.number,
      repo,
      preflight: {
        argv: ["issue", "view", ...viewArgs],
        closed: false,
        pointerSeen: false,
        skipped: true,
      },
      comment: { argv: ["issue", "comment", ...commentArgs], body: commentBody },
      close: { argv: closeArgs, reason: opts.reason },
      label: labelArgs
        ? { argv: ["issue", "edit", ...labelArgs], name: opts.label! }
        : undefined,
      dryRun: true,
      exitCode: 0,
    };
    output.log(formatIntakeMergeRender(render, opts.format));
    return 0;
  }

  // Pre-flight: read dup state + comments so retries are idempotent.
  // Upstream of any write — partial-state safety is unaffected on parse failure.
  const viewResult: GhExecResult = ghExec(
    {
      group: "issue",
      subcommand: "view",
      args: viewArgs,
      state: "planning",
      role: "executor",
    },
    processEnv(),
  );
  if (viewResult.exitCode !== 0) {
    const detail =
      viewResult.stderr.trim() ||
      viewResult.stdout.trim() ||
      "gh issue view failed";
    output.error(`${VERB}: ${detail}`);
    return viewResult.exitCode || 1;
  }
  const view = parsePreflightView(viewResult.stdout);
  // If the view stdout fails to parse, treat as "no pre-flight info available"
  // and fall through to the normal flow — best-effort de-dup, not correctness.
  const closed = view?.state === "CLOSED";
  const pointerSeen =
    view?.comments.some((c) => c.body === commentBody) ?? false;

  if (closed) {
    const render: IntakeMergeRender = {
      backend: "gh",
      dupNumber: dup.number,
      canonicalNumber: canonical.number,
      repo,
      preflight: {
        argv: ["issue", "view", ...viewArgs],
        closed: true,
        pointerSeen,
        skipped: false,
      },
      comment: { argv: ["issue", "comment", ...commentArgs], body: commentBody },
      close: { argv: closeArgs, reason: opts.reason },
      label: labelArgs
        ? { argv: ["issue", "edit", ...labelArgs], name: opts.label! }
        : undefined,
      dryRun: false,
      exitCode: 0,
    };
    output.log(
      `${VERB}: GH-${dup.number} already closed — skipping comment + close`,
    );
    output.log(formatIntakeMergeRender(render, opts.format));
    return 0;
  }

  // Step 1: pointer comment (skipped when the canonical pointer is already present).
  if (!pointerSeen) {
    const commentResult: GhExecResult = ghExec(
      {
        group: "issue",
        subcommand: "comment",
        args: commentArgs,
        state: "planning",
        role: "executor",
      },
      processEnv(),
    );
    if (commentResult.exitCode !== 0) {
      const detail =
        commentResult.stderr.trim() ||
        commentResult.stdout.trim() ||
        "gh issue comment failed";
      output.error(`${VERB}: ${detail}`);
      return commentResult.exitCode || 1;
    }
  }

  // Step 2: close. On failure, comment is *not* rolled back — surface a
  // partial-state warning and propagate the exit code.
  const closeResult: GhIssueCloseResult = ghClose({
    number: dup.number,
    reason: opts.reason,
    repo,
  });
  if (closeResult.exitCode !== 0) {
    const detail =
      closeResult.stderr.trim() ||
      closeResult.stdout.trim() ||
      "gh issue close failed";
    output.error(`${VERB}: ${detail}`);
    output.error(
      `${VERB}: comment posted but close failed — issue is in partial state (GH-${dup.number})`,
    );
    return closeResult.exitCode || 1;
  }

  // Step 3 (optional): --add-label. Non-fatal — close already succeeded.
  if (labelArgs) {
    const labelResult: GhExecResult = ghExec(
      {
        group: "issue",
        subcommand: "edit",
        args: labelArgs,
        state: "planning",
        role: "executor",
      },
      processEnv(),
    );
    if (labelResult.exitCode !== 0) {
      const detail =
        labelResult.stderr.trim() ||
        labelResult.stdout.trim() ||
        "gh issue edit failed";
      output.error(
        `${VERB}: close succeeded but --add-label '${opts.label}' failed: ${detail}`,
      );
    }
  }

  const render: IntakeMergeRender = {
    backend: "gh",
    dupNumber: dup.number,
    canonicalNumber: canonical.number,
    repo,
    preflight: {
      argv: ["issue", "view", ...viewArgs],
      closed: false,
      pointerSeen,
      skipped: false,
    },
    comment: { argv: ["issue", "comment", ...commentArgs], body: commentBody },
    close: { argv: closeArgs, reason: opts.reason },
    label: labelArgs
      ? { argv: ["issue", "edit", ...labelArgs], name: opts.label! }
      : undefined,
    dryRun: false,
    exitCode: 0,
  };
  output.log(formatIntakeMergeRender(render, opts.format));
  return 0;
}

function runBdMerge(
  opts: IntakeMergeOptions,
  output: Output,
  dupId: string,
  canonicalId: string,
  bdExec: typeof execBd,
  bdClose: typeof execBdIssueClose,
  loader: typeof loadAllBeads,
): number {
  const body = `Merging into ${canonicalId}`;
  const marker = buildNotesAppendMarker("prx-intake-merge", body);
  const bdCloseArgv = buildBdIssueCloseArgs({ id: dupId, reason: opts.reason });

  if (opts.dryRun) {
    const placeholderNotes = composeAppendedNotes(null, marker, body);
    const render: IntakeMergeRender = {
      backend: "bd",
      dupId,
      canonicalId,
      marker,
      body,
      bdUpdateArgv: buildBdUpdateArgs(dupId, placeholderNotes),
      bdCloseArgv,
      reason: opts.reason,
      alreadyClosed: false,
      pointerAlreadyPresent: false,
      dryRun: true,
      exitCode: 0,
    };
    output.log(formatIntakeMergeRender(render, opts.format));
    return 0;
  }

  let records;
  try {
    records = loader(bdExec);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    output.error(`${VERB}: bd unreachable: ${detail}`);
    return 1;
  }
  const dupRecord = records.find((r) => r.id === dupId);
  if (!dupRecord) {
    output.error(`${VERB}: no bd record matching '${dupId}'`);
    return 1;
  }

  // Cross-backend safety: a bd record carrying a non-null `external_ref` is
  // pinned to a GH issue. Merging it as bd-only would leave the GH pin
  // dangling; the operator should run `prx intake merge GH-N GH-M` against
  // the projected GH ids instead. Cross-backend merge is out of scope per
  // GH-1913.
  if (dupRecord.externalRef !== null && dupRecord.externalRef.trim().length > 0) {
    output.error(
      `${VERB}: bd record '${dupId}' is pinned to a GH issue (external_ref=${dupRecord.externalRef}); cross-backend merge is out of scope — run 'prx intake merge GH-N GH-M' on the projected GH ids`,
    );
    return 1;
  }

  const alreadyClosed = dupRecord.status === "closed";
  const pointerAlreadyPresent = notesAlreadyContains(dupRecord.notes, marker);

  if (alreadyClosed) {
    const render: IntakeMergeRender = {
      backend: "bd",
      dupId,
      canonicalId,
      marker,
      body,
      bdUpdateArgv: buildBdUpdateArgs(
        dupId,
        pointerAlreadyPresent
          ? (dupRecord.notes ?? "")
          : composeAppendedNotes(dupRecord.notes, marker, body),
      ),
      bdCloseArgv,
      reason: opts.reason,
      alreadyClosed: true,
      pointerAlreadyPresent,
      dryRun: false,
      exitCode: 0,
    };
    output.log(
      `${VERB}: ${dupId} already closed — skipping comment + close`,
    );
    output.log(formatIntakeMergeRender(render, opts.format));
    return 0;
  }

  // Step 1: pointer comment (skipped when marker is already present).
  let bdUpdateArgv: string[];
  if (pointerAlreadyPresent) {
    bdUpdateArgv = buildBdUpdateArgs(dupId, dupRecord.notes ?? "");
  } else {
    const newNotes = composeAppendedNotes(dupRecord.notes, marker, body);
    bdUpdateArgv = buildBdUpdateArgs(dupId, newNotes);
    const updateResult: BdExecResult = bdExec(
      {
        subcommand: "update",
        args: bdUpdateArgv,
        state: "planning",
        role: "planner",
      },
      processEnv(),
    );
    if (updateResult.exitCode !== 0) {
      const detail =
        updateResult.stderr.trim() ||
        updateResult.stdout.trim() ||
        "bd update failed";
      output.error(`${VERB}: ${detail}`);
      return updateResult.exitCode || 1;
    }
  }

  // Step 2: close. On failure, the appended notes are not rolled back —
  // surface a partial-state warning and propagate the exit code.
  const closeResult: BdIssueCloseResult = bdClose({
    id: dupId,
    reason: opts.reason,
  });
  if (closeResult.exitCode !== 0) {
    const detail =
      closeResult.stderr.trim() ||
      closeResult.stdout.trim() ||
      "bd close failed";
    output.error(`${VERB}: ${detail}`);
    output.error(
      `${VERB}: pointer note appended but close failed — record is in partial state (${dupId})`,
    );
    return closeResult.exitCode || 1;
  }

  const render: IntakeMergeRender = {
    backend: "bd",
    dupId,
    canonicalId,
    marker,
    body,
    bdUpdateArgv,
    bdCloseArgv,
    reason: opts.reason,
    alreadyClosed: false,
    pointerAlreadyPresent,
    dryRun: false,
    exitCode: 0,
  };
  output.log(formatIntakeMergeRender(render, opts.format));
  return 0;
}

export function formatIntakeMergeRender(
  render: IntakeMergeRender,
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(render, null, 2);
  }
  if (render.backend === "bd") {
    return formatBdRender(render);
  }
  return formatGhRender(render);
}

function formatGhRender(
  render: Extract<IntakeMergeRender, { backend: "gh" }>,
): string {
  const header = render.dryRun
    ? "prx intake merge (dry-run)"
    : "prx intake merge";
  const preflightSummary = render.preflight.skipped
    ? "(skipped — dry-run)"
    : render.preflight.closed
      ? `closed=true pointer=${render.preflight.pointerSeen}`
      : `closed=false pointer=${render.preflight.pointerSeen}`;
  const lines: string[] = [
    header,
    `  dup:        GH-${render.dupNumber}`,
    `  canonical:  GH-${render.canonicalNumber}`,
    `  repo:       ${render.repo ?? "(default — gh's git remote)"}`,
    `  reason:     ${render.close.reason}`,
    `  comment:    ${render.comment.body}`,
    `  preflight:  ${preflightSummary}`,
  ];
  if (render.dryRun) {
    lines.push(`  would run:`);
    lines.push(`    ${renderGhArgvLine(render.preflight.argv)}`);
    lines.push(`    ${renderGhArgvLine(render.comment.argv)}`);
    lines.push(`    ${renderGhArgvLine(render.close.argv)}`);
    if (render.label) {
      lines.push(`    ${renderGhArgvLine(render.label.argv)}`);
    }
  } else if (render.label) {
    lines.push(`  label:      ${render.label.name}`);
  }
  return lines.join("\n");
}

function formatBdRender(
  render: Extract<IntakeMergeRender, { backend: "bd" }>,
): string {
  const header = render.dryRun
    ? "prx intake merge (dry-run)"
    : "prx intake merge";
  const preflightSummary = render.dryRun
    ? "(skipped — dry-run)"
    : render.alreadyClosed
      ? `closed=true pointer=${render.pointerAlreadyPresent}`
      : `closed=false pointer=${render.pointerAlreadyPresent}`;
  const lines: string[] = [
    header,
    `  dup:        ${render.dupId}`,
    `  canonical:  ${render.canonicalId}`,
    `  backend:    bd`,
    `  reason:     ${render.reason}`,
    `  comment:    ${render.body}`,
    `  preflight:  ${preflightSummary}`,
  ];
  if (render.dryRun) {
    lines.push(`  would run:`);
    lines.push(`    ${renderBdArgvLine(["update", ...render.bdUpdateArgv])}`);
    lines.push(`    ${renderBdArgvLine(render.bdCloseArgv)}`);
  }
  return lines.join("\n");
}
