/**
 * `prx intake comment <canonical> --body …` — pointer comment without close
 * (GH-1323, sister of `prx intake merge`).
 *
 * GitHub is the write plane, so this verb only comments on GH issues:
 *   - `kind === "gh"` → `gh issue comment` flow.
 *   - `kind === "notion"` → refused (Notion is read-only via `prx scout
 *     notion`).
 *   - `kind === "bd"` → refused: bd records carry no writable comment surface
 *     (Front Desk is the read plane; there is no bd write backend anymore).
 *
 * Mirrors src/intake/intake-merge.ts: pure upstream-of-parity-chain CLI
 * plumbing, no XState events, no schema scaffolding. Body resolution
 * (`--body`, `--body-file`, `--body-stdin`) lives at the CLI parse layer; this
 * module receives the already-resolved string. Single-step, so no
 * partial-state warning.
 */

import { processEnv } from "@bounded-systems/env";
import { z } from "zod";

import { IssueResolveError, resolveIssueId, type IssueResolvedId } from "../issues/resolver.ts";
import { execGh, type GhExecResult } from "@bounded-systems/gh";

export const intakeCommentOptionsSchema = z.object({
  canonicalId: z.string().trim().min(1, "canonical id must not be empty"),
  body: z.string().min(1, "body must not be empty"),
  repo: z.string().optional(),
  dryRun: z.boolean().default(false),
  format: z.enum(["plain", "json"]).default("plain"),
});

export type IntakeCommentOptions = z.infer<typeof intakeCommentOptionsSchema>;

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

export type IntakeCommentRender = {
  backend: "gh";
  canonicalNumber: number;
  repo?: string | undefined;
  comment: { argv: string[]; body: string };
  dryRun: boolean;
  exitCode: number;
};

export type IntakeCommentDeps = {
  execGh?: typeof execGh;
};

export class IntakeCommentError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "IntakeCommentError";
    this.exitCode = exitCode;
  }
}

const VERB = "prx intake comment";

function buildCommentArgs(
  canonicalNumber: number,
  body: string,
  repo: string | undefined,
): string[] {
  const args: string[] = [String(canonicalNumber), "--body", body];
  if (repo) {
    args.push("--repo", repo);
  }
  return args;
}

function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  // `#` is excluded from the safe set: `#123` (the most common pointer-
  // comment shape) is a POSIX comment-introducer, so the rendered argv must
  // single-quote any token containing `#` to stay copy-paste-runnable.
  if (/^[A-Za-z0-9_/.:@=+\-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function renderGhArgvLine(args: string[]): string {
  return `gh ${args.map(shellQuote).join(" ")}`;
}

export function runIntakeComment(
  opts: IntakeCommentOptions,
  output: Output,
  deps: IntakeCommentDeps = {},
): number {
  const ghExec = deps.execGh ?? execGh;

  let resolved: IssueResolvedId;
  try {
    resolved = resolveIssueId(opts.canonicalId, VERB);
  } catch (err) {
    if (err instanceof IssueResolveError) {
      output.error(err.message);
      return err.exitCode;
    }
    throw err;
  }

  if (resolved.kind === "notion") {
    output.error(
      `${VERB}: canonical id must be a GitHub issue; Notion ids are read-only via 'prx scout notion'`,
    );
    return 1;
  }

  if (resolved.kind === "bd") {
    output.error(
      `${VERB}: canonical id must be a GitHub issue; bd records have no writable comment surface`,
    );
    return 1;
  }

  return runGhComment(opts, output, resolved, ghExec);
}

function runGhComment(
  opts: IntakeCommentOptions,
  output: Output,
  canonical: { number: number; repo?: string },
  ghExec: typeof execGh,
): number {
  // Repo precedence: explicit --repo wins; otherwise the URL form supplies
  // it. When neither, gh uses the cwd's git remote.
  const repo = opts.repo ?? canonical.repo;

  const commentArgs = buildCommentArgs(canonical.number, opts.body, repo);

  if (opts.dryRun) {
    const render: IntakeCommentRender = {
      backend: "gh",
      canonicalNumber: canonical.number,
      repo,
      comment: {
        argv: ["issue", "comment", ...commentArgs],
        body: opts.body,
      },
      dryRun: true,
      exitCode: 0,
    };
    output.log(formatIntakeCommentRender(render, opts.format));
    return 0;
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
    output.error(`${VERB}: ${detail}`);
    return commentResult.exitCode || 1;
  }

  const render: IntakeCommentRender = {
    backend: "gh",
    canonicalNumber: canonical.number,
    repo,
    comment: {
      argv: ["issue", "comment", ...commentArgs],
      body: opts.body,
    },
    dryRun: false,
    exitCode: 0,
  };
  output.log(formatIntakeCommentRender(render, opts.format));
  return 0;
}

export function formatIntakeCommentRender(
  render: IntakeCommentRender,
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(render, null, 2);
  }
  return formatGhRender(render);
}

function formatGhRender(render: IntakeCommentRender): string {
  const header = render.dryRun ? "prx intake comment (dry-run)" : "prx intake comment";
  const lines: string[] = [
    header,
    `  canonical:  GH-${render.canonicalNumber}`,
    `  repo:       ${render.repo ?? "(default — gh's git remote)"}`,
  ];
  // Multi-line bodies (--body-file / --body-stdin) get a label-only line
  // followed by indented continuation lines so the plain output stays
  // readable instead of wrapping back to column 0.
  const bodyLines = render.comment.body.split("\n");
  if (bodyLines.length === 1) {
    lines.push(`  comment:    ${bodyLines[0]}`);
  } else {
    lines.push(`  comment:`);
    for (const line of bodyLines) {
      lines.push(`    ${line}`);
    }
  }
  if (render.dryRun) {
    lines.push(`  would run:`);
    lines.push(`    ${renderGhArgvLine(render.comment.argv)}`);
  }
  return lines.join("\n");
}
