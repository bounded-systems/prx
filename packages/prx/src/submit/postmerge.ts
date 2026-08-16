/**
 * `prx submit postmerge <pr-number>` (GH-1318, Option B — post-merge cleanup).
 *
 * Sweeps a merged PR's body + title for canonical-id refs (GH-1318's
 * incident class: `(GH-N)` suffix in the PR title is decorative, not a
 * GitHub auto-close keyword, so siblings + single-target PRs leak open
 * issues on merge). Subtracts `closingIssuesReferences` (issues GitHub
 * already auto-closed), skips already-CLOSED targets, and closes the rest
 * with a pointer comment crediting `prx submit postmerge`.
 *
 * Built on the same DI seam as `intake-merge`: `execGh` for the issue-view
 * preflight + the pointer comment, `execGhIssueClose` for the close
 * mutation, `execGhPrView` for the PR snapshot.
 */

import { processEnv } from "@bounded-systems/env";
import { z } from "zod";

import { execGh, type GhExecResult } from "@bounded-systems/gh";
import {
  buildGhIssueCloseArgs,
  execGhIssueClose,
  type GhIssueCloseResult,
} from "../tools/gh_issue_close.ts";
import {
  buildGhPrViewArgs,
  execGhPrView,
  parseGhPrViewJson,
  type GhPrViewResult,
} from "../tools/gh_pr_view.ts";
import { GH_PREFIX_RE } from "../issues/resolver.ts";
import { loadIdentityConfig } from "../pr-state/github.ts";
import type { IdentityConfig } from "../pr-state/github.ts";
import { extractCanonicalRefs } from "./extract-refs.ts";

const DEFAULT_COMMENT_TEMPLATE =
  "Closed by #${pr} — postmerge sweep (GH-1318). Mentioned in the merged PR but not in `closingIssuesReferences`; closing via `prx submit postmerge`.";

export const postmergeOptionsSchema = z.object({
  prNumber: z.number().int().positive(),
  repo: z.string().optional(),
  dryRun: z.boolean().default(false),
  format: z.enum(["plain", "json"]).default("plain"),
  commentTemplate: z.string().default(DEFAULT_COMMENT_TEMPLATE),
  cwd: z.string().optional(),
});

export type PostmergeOptions = z.infer<typeof postmergeOptionsSchema>;

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

export type PostmergeTargetResult =
  | { kind: "closed"; number: number; commentArgv: string[]; closeArgv: string[] }
  | { kind: "skip:auto-closed"; number: number }
  | { kind: "skip:already-closed"; number: number }
  | { kind: "error"; number: number; detail: string };

export type PostmergeRender = {
  prNumber: number;
  repo?: string | undefined;
  state: "OPEN" | "CLOSED" | "MERGED";
  mergedAt: string | null;
  extracted: string[];
  closingIssuesReferences: number[];
  candidates: number[];
  targets: PostmergeTargetResult[];
  prViewArgv: string[];
  dryRun: boolean;
  exitCode: number;
};

export type PostmergeDeps = {
  execGh?: typeof execGh;
  execGhIssueClose?: typeof execGhIssueClose;
  execGhPrView?: typeof execGhPrView;
  loadIdentityConfig?: (repoPath: string) => IdentityConfig;
};

export class PostmergeError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "PostmergeError";
    this.exitCode = exitCode;
  }
}

function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  if (/^[A-Za-z0-9_/.:@=+\-#]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function renderArgvLine(args: string[]): string {
  return `gh ${args.map(shellQuote).join(" ")}`;
}

function composeComment(template: string, prNumber: number): string {
  return template.replaceAll("${pr}", String(prNumber));
}

function buildIssueViewArgs(n: number, repo: string | undefined): string[] {
  const args: string[] = [String(n), "--json", "state"];
  if (repo) args.push("--repo", repo);
  return args;
}

function buildCommentArgs(n: number, body: string, repo: string | undefined): string[] {
  const args: string[] = [String(n), "--body", body];
  if (repo) args.push("--repo", repo);
  return args;
}

function ghOnlyRefsToNumbers(refs: string[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const ref of refs) {
    const match = ref.match(GH_PREFIX_RE);
    if (!match) continue;
    const n = Number.parseInt(match[1]!, 10);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function parseIssueViewState(stdout: string): "OPEN" | "CLOSED" | null {
  try {
    const raw = JSON.parse(stdout) as { state?: unknown };
    if (raw.state === "OPEN" || raw.state === "CLOSED") return raw.state;
    return null;
  } catch {
    return null;
  }
}

export function runPostmerge(
  opts: PostmergeOptions,
  output: Output,
  deps: PostmergeDeps = {},
): number {
  const ghExec = deps.execGh ?? execGh;
  const ghClose = deps.execGhIssueClose ?? execGhIssueClose;
  const ghPrView = deps.execGhPrView ?? execGhPrView;
  const loadIdentity = deps.loadIdentityConfig ?? loadIdentityConfig;

  const repo = opts.repo;
  const cwd = opts.cwd ?? process.cwd();
  const prViewArgv = buildGhPrViewArgs({ number: opts.prNumber, repo, cwd });

  const viewResult: GhPrViewResult = ghPrView({ number: opts.prNumber, repo, cwd });
  if (viewResult.exitCode !== 0) {
    const detail = viewResult.stderr.trim() || viewResult.stdout.trim() || "gh pr view failed";
    output.error(`prx submit postmerge: ${detail}`);
    return 2;
  }
  const view = parseGhPrViewJson(viewResult.stdout);
  if (!view) {
    output.error(`prx submit postmerge: failed to parse gh pr view --json (pr #${opts.prNumber})`);
    return 2;
  }
  if (view.state !== "MERGED") {
    output.error(
      `prx submit postmerge: pr #${opts.prNumber} is not merged (state=${view.state}) — refusing sweep (postmerge only)`,
    );
    return 2;
  }

  const identity = loadIdentity(cwd);
  const blob = `${view.body ?? ""} ${view.title ?? ""}`;
  const extracted = extractCanonicalRefs(blob, identity);
  const ghNumbers = ghOnlyRefsToNumbers(extracted);
  const autoClosed = new Set(view.closingIssuesReferences.map((r) => r.number));
  const candidates = ghNumbers.filter((n) => !autoClosed.has(n));

  const targets: PostmergeTargetResult[] = [];
  let hadError = false;

  // Record auto-closed skips first for deterministic output ordering.
  for (const n of ghNumbers) {
    if (autoClosed.has(n)) {
      targets.push({ kind: "skip:auto-closed", number: n });
    }
  }

  for (const n of candidates) {
    const viewArgs = buildIssueViewArgs(n, repo);
    const commentBody = composeComment(opts.commentTemplate, opts.prNumber);
    const commentArgs = buildCommentArgs(n, commentBody, repo);
    const closeArgs = buildGhIssueCloseArgs({ number: n, reason: "completed", repo });

    if (opts.dryRun) {
      targets.push({
        kind: "closed",
        number: n,
        commentArgv: ["issue", "comment", ...commentArgs],
        closeArgv: closeArgs,
      });
      continue;
    }

    // Idempotency: skip targets that are already CLOSED.
    const issueView: GhExecResult = ghExec(
      {
        group: "issue",
        subcommand: "view",
        args: viewArgs,
        state: "planning",
        role: "executor",
      },
      processEnv(),
    );
    if (issueView.exitCode !== 0) {
      const detail = issueView.stderr.trim() || issueView.stdout.trim() || "gh issue view failed";
      targets.push({ kind: "error", number: n, detail });
      hadError = true;
      continue;
    }
    const state = parseIssueViewState(issueView.stdout);
    if (state === "CLOSED") {
      targets.push({ kind: "skip:already-closed", number: n });
      continue;
    }

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
      targets.push({ kind: "error", number: n, detail });
      hadError = true;
      continue;
    }

    const closeResult: GhIssueCloseResult = ghClose({
      number: n,
      reason: "completed",
      repo,
    });
    if (closeResult.exitCode !== 0) {
      const detail =
        closeResult.stderr.trim() || closeResult.stdout.trim() || "gh issue close failed";
      targets.push({ kind: "error", number: n, detail });
      hadError = true;
      continue;
    }

    targets.push({
      kind: "closed",
      number: n,
      commentArgv: ["issue", "comment", ...commentArgs],
      closeArgv: closeArgs,
    });
  }

  const exitCode = hadError ? 1 : 0;
  const render: PostmergeRender = {
    prNumber: opts.prNumber,
    repo,
    state: view.state,
    mergedAt: view.mergedAt,
    extracted,
    closingIssuesReferences: [...autoClosed].sort((a, b) => a - b),
    candidates,
    targets,
    prViewArgv,
    dryRun: opts.dryRun,
    exitCode,
  };
  output.log(formatPostmergeRender(render, opts.format));
  return exitCode;
}

export function formatPostmergeRender(render: PostmergeRender, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(render, null, 2);
  }
  const header = render.dryRun ? "prx submit postmerge (dry-run)" : "prx submit postmerge";
  const lines: string[] = [
    header,
    `  pr:                  #${render.prNumber}`,
    `  repo:                ${render.repo ?? "(default — gh's git remote)"}`,
    `  merged at:           ${render.mergedAt ?? "(unknown)"}`,
    `  extracted refs:      ${render.extracted.length === 0 ? "(none)" : render.extracted.join(", ")}`,
    `  auto-closed (skip):  ${render.closingIssuesReferences.length === 0 ? "(none)" : render.closingIssuesReferences.join(", ")}`,
    `  candidates:          ${render.candidates.length === 0 ? "(none)" : render.candidates.join(", ")}`,
  ];
  for (const t of render.targets) {
    if (t.kind === "closed") {
      const tag = render.dryRun ? "would close" : "closed";
      lines.push(`  - GH-${t.number}: ${tag}`);
      if (render.dryRun) {
        lines.push(`      ${renderArgvLine(t.commentArgv)}`);
        lines.push(`      ${renderArgvLine(t.closeArgv)}`);
      }
    } else if (t.kind === "skip:auto-closed") {
      lines.push(`  - GH-${t.number}: skip (already in closingIssuesReferences)`);
    } else if (t.kind === "skip:already-closed") {
      lines.push(`  - GH-${t.number}: skip (already CLOSED)`);
    } else {
      lines.push(`  - GH-${t.number}: ERROR — ${t.detail}`);
    }
  }
  lines.push(`  exit:                ${render.exitCode}`);
  return lines.join("\n");
}

export { DEFAULT_COMMENT_TEMPLATE };
