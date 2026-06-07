/**
 * `prx intake comment <canonical> --body …` — pointer comment without close
 * (GH-1323, sister of `prx intake merge`).
 *
 * After GH-1710 (canonical-bd conversion), the canonical id may be a bd-side
 * id (`ai-home-<slug>`) rather than a GH issue. GH-1913 widens this verb to
 * dispatch on the resolved canonical:
 *   - `kind === "gh"` → existing `gh issue comment` flow.
 *   - `kind === "bd"` → marker-append onto the bd record's `notes` column
 *     (bd has no native comment surface).
 *   - `kind === "notion"` → refused (Notion is read-only via `prx scout
 *     notion`).
 *
 * Mirrors src/intake/intake-merge.ts: pure upstream-of-parity-chain CLI
 * plumbing, no XState events, no schema scaffolding. Body resolution
 * (`--body`, `--body-file`, `--body-stdin`) lives at the CLI parse layer; this
 * module receives the already-resolved string. Single-step, so no
 * partial-state warning.
 */

import { processEnv } from "@bounded-systems/env";
import { z } from "zod";

import {
  IssueResolveError,
  resolveIssueId,
  type IssueResolvedId,
} from "../issues/resolver.ts";
import { execBd } from "@bounded-systems/bd";
import { defaultRunner as procRunner, type CommandRunner } from "@bounded-systems/proc";
import { execGh, type GhExecResult } from "@bounded-systems/gh";
import { loadAllBeads } from "../triage/triage.ts";
import {
  buildNotesAppendMarker,
  composeAppendedNotes,
  notesAlreadyContains,
} from "./notes-append.ts";

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

export type IntakeCommentRender =
  | {
      backend: "gh";
      canonicalNumber: number;
      repo?: string | undefined;
      comment: { argv: string[]; body: string };
      dryRun: boolean;
      exitCode: number;
    }
  | {
      backend: "bd";
      bdId: string;
      marker: string;
      body: string;
      bdUpdateArgv: string[];
      alreadyPresent: boolean;
      dryRun: boolean;
      exitCode: number;
    };

export type IntakeCommentDeps = {
  execGh?: typeof execGh;
  execBd?: typeof execBd;
  loadAllBeads?: typeof loadAllBeads;
  /**
   * GH-296 / prx-82b — sync runner for the daemon-routed note write
   * (`prx beads update <id> --notes …`). Default: procRunner.
   */
  run?: CommandRunner;
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

function buildBdUpdateArgs(bdId: string, newNotes: string): string[] {
  return [bdId, "--notes", newNotes];
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

function renderBdUpdateArgvLine(args: string[]): string {
  return `bd update ${args.map(shellQuote).join(" ")}`;
}

export function runIntakeComment(
  opts: IntakeCommentOptions,
  output: Output,
  deps: IntakeCommentDeps = {},
): number {
  const ghExec = deps.execGh ?? execGh;
  const bdExec = deps.execBd ?? execBd;
  const loader = deps.loadAllBeads ?? loadAllBeads;
  const run = deps.run ?? procRunner;

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
      `${VERB}: canonical id must be a GitHub issue or bd record; Notion ids are read-only via 'prx scout notion'`,
    );
    return 1;
  }

  if (resolved.kind === "bd") {
    return runBdComment(opts, output, resolved.id, bdExec, loader, run);
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
      commentResult.stderr.trim() ||
      commentResult.stdout.trim() ||
      "gh issue comment failed";
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

function runBdComment(
  opts: IntakeCommentOptions,
  output: Output,
  bdId: string,
  bdExec: typeof execBd,
  loader: typeof loadAllBeads,
  run: CommandRunner,
): number {
  let records;
  try {
    records = loader(bdExec);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    output.error(`${VERB}: bd unreachable: ${detail}`);
    return 1;
  }
  const record = records.find((r) => r.id === bdId);
  if (!record) {
    output.error(`${VERB}: no bd record matching '${bdId}'`);
    return 1;
  }

  const marker = buildNotesAppendMarker("prx-intake-comment", opts.body);
  const alreadyPresent = notesAlreadyContains(record.notes, marker);
  const newNotes = alreadyPresent
    ? (record.notes ?? "")
    : composeAppendedNotes(record.notes, marker, opts.body);
  const bdUpdateArgv = buildBdUpdateArgs(bdId, newNotes);

  if (opts.dryRun) {
    const render: IntakeCommentRender = {
      backend: "bd",
      bdId,
      marker,
      body: opts.body,
      bdUpdateArgv,
      alreadyPresent,
      dryRun: true,
      exitCode: 0,
    };
    output.log(formatIntakeCommentRender(render, opts.format));
    return 0;
  }

  if (alreadyPresent) {
    output.log(
      `${VERB}: marker already present on '${bdId}' — idempotent no-op`,
    );
    const render: IntakeCommentRender = {
      backend: "bd",
      bdId,
      marker,
      body: opts.body,
      bdUpdateArgv,
      alreadyPresent: true,
      dryRun: false,
      exitCode: 0,
    };
    output.log(formatIntakeCommentRender(render, opts.format));
    return 0;
  }

  // GH-296 / prx-82b: write the note via the daemon (single writer).
  const updateResult = run(["prx", "beads", "update", bdId, "--notes", newNotes], { check: false });
  if (updateResult.status !== 0) {
    const detail =
      updateResult.stderr.trim() ||
      updateResult.stdout.trim() ||
      "prx beads update failed";
    output.error(`${VERB}: ${detail}`);
    return updateResult.status || 1;
  }

  const render: IntakeCommentRender = {
    backend: "bd",
    bdId,
    marker,
    body: opts.body,
    bdUpdateArgv,
    alreadyPresent: false,
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
  if (render.backend === "bd") {
    return formatBdRender(render);
  }
  return formatGhRender(render);
}

function formatGhRender(
  render: Extract<IntakeCommentRender, { backend: "gh" }>,
): string {
  const header = render.dryRun
    ? "prx intake comment (dry-run)"
    : "prx intake comment";
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

function formatBdRender(
  render: Extract<IntakeCommentRender, { backend: "bd" }>,
): string {
  const header = render.dryRun
    ? "prx intake comment (dry-run)"
    : "prx intake comment";
  const lines: string[] = [
    header,
    `  canonical:  ${render.bdId}`,
    `  backend:    bd`,
    `  marker:     ${render.marker}`,
    `  status:     ${render.alreadyPresent ? "already-present (no-op)" : "appended"}`,
  ];
  const bodyLines = render.body.split("\n");
  if (bodyLines.length === 1) {
    lines.push(`  body:       ${bodyLines[0]}`);
  } else {
    lines.push(`  body:`);
    for (const line of bodyLines) {
      lines.push(`    ${line}`);
    }
  }
  if (render.dryRun) {
    lines.push(`  would run:`);
    lines.push(`    ${renderBdUpdateArgvLine(render.bdUpdateArgv)}`);
  }
  return lines.join("\n");
}
