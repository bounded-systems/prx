/**
 * `prx intake merge <dup> <canonical>` — pointer-comment + close (GH-1001,
 * part of GH-998). Replaces the raw `gh issue comment <n>` + `gh issue close
 * <n>` pair operators run by hand during dedupe; GH-1004 has now dropped
 * `Bash(gh issue comment:*)` (and the rest of the raw `gh:*` / `git:*`
 * surface) from the intake profile allowlist and denies them at the Claude
 * `--disallowedTools` flag layer, so this verb is the *only* way to
 * comment-and-close a duplicate from inside an intake session.
 *
 * GH is the sole write plane (GH-1012 removed the bd backend). Both positionals
 * must resolve to GitHub ids; bd ids are refused with a hint. Notion ids are
 * read-only and likewise refused.
 *
 * Mirrors src/intake/intake-view.ts and src/intake/intake-search.ts: pure
 * upstream-of-parity-chain CLI plumbing, no XState events, no schema
 * scaffolding. The verb is *not* atomic — it is comment-then-close with
 * documented partial-recovery semantics on close failure.
 */

import { processEnv } from "@bounded-systems/env";
import { z } from "zod";

import { IssueResolveError, resolveIssueId, type IssueResolvedId } from "../issues/resolver.ts";
import { execGh, type GhExecResult } from "@bounded-systems/gh";
import {
  buildGhIssueCloseArgs,
  execGhIssueClose,
  type GhIssueCloseResult,
  type GhIssueCloseStateReason,
} from "../tools/gh_issue_close.ts";

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

export type IntakeMergeRender = {
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
};

export type IntakeMergeDeps = {
  execGh?: typeof execGh;
  execGhIssueClose?: typeof execGhIssueClose;
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

function buildIssueViewArgs(dupNumber: number, repo: string | undefined): string[] {
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
    const state = obj.state === "OPEN" || obj.state === "CLOSED" ? obj.state : null;
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

function buildCommentArgs(dupNumber: number, body: string, repo: string | undefined): string[] {
  const args: string[] = [String(dupNumber), "--body", body];
  if (repo) {
    args.push("--repo", repo);
  }
  return args;
}

function buildLabelEditArgs(dupNumber: number, label: string, repo: string | undefined): string[] {
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

export function runIntakeMerge(
  opts: IntakeMergeOptions,
  output: Output,
  deps: IntakeMergeDeps = {},
): number {
  const ghExec = deps.execGh ?? execGh;
  const ghClose = deps.execGhIssueClose ?? execGhIssueClose;

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
      `${VERB}: Notion ids are read-only via 'prx scout notion'; merge into a GH canonical instead`,
    );
    return 1;
  }

  if (dup.kind === "bd" || canonical.kind === "bd") {
    output.error(
      `${VERB}: the bd backend has been removed (GH-1012); merge GitHub issues instead (both GH-N)`,
    );
    return 1;
  }

  // Notion and bd were refused above, leaving only (gh, gh). GH is the sole
  // write plane (GH-1012 removed the bd backend), so there is no longer a
  // cross-backend dispatch to arbitrate.
  return runGhMerge(
    opts,
    output,
    { number: dup.number, repo: dup.repo },
    { number: canonical.number, repo: canonical.repo },
    ghExec,
    ghClose,
  );
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
  const labelArgs = opts.label ? buildLabelEditArgs(dup.number, opts.label, repo) : null;

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
      label: labelArgs ? { argv: ["issue", "edit", ...labelArgs], name: opts.label! } : undefined,
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
    const detail = viewResult.stderr.trim() || viewResult.stdout.trim() || "gh issue view failed";
    output.error(`${VERB}: ${detail}`);
    return viewResult.exitCode || 1;
  }
  const view = parsePreflightView(viewResult.stdout);
  // If the view stdout fails to parse, treat as "no pre-flight info available"
  // and fall through to the normal flow — best-effort de-dup, not correctness.
  const closed = view?.state === "CLOSED";
  const pointerSeen = view?.comments.some((c) => c.body === commentBody) ?? false;

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
      label: labelArgs ? { argv: ["issue", "edit", ...labelArgs], name: opts.label! } : undefined,
      dryRun: false,
      exitCode: 0,
    };
    output.log(`${VERB}: GH-${dup.number} already closed — skipping comment + close`);
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
        commentResult.stderr.trim() || commentResult.stdout.trim() || "gh issue comment failed";
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
      closeResult.stderr.trim() || closeResult.stdout.trim() || "gh issue close failed";
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
        labelResult.stderr.trim() || labelResult.stdout.trim() || "gh issue edit failed";
      output.error(`${VERB}: close succeeded but --add-label '${opts.label}' failed: ${detail}`);
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
    label: labelArgs ? { argv: ["issue", "edit", ...labelArgs], name: opts.label! } : undefined,
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
  return formatGhRender(render);
}

function formatGhRender(render: IntakeMergeRender): string {
  const header = render.dryRun ? "prx intake merge (dry-run)" : "prx intake merge";
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
