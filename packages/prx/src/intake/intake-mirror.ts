/**
 * `prx intake mirror <gh-id>` — idempotent bd create with race-check (GH-1002,
 * part of GH-998). After filing a GH issue (or merging duplicates), the intake
 * operator may need to mirror the surviving issue into beads (typed dep graph,
 * claim flow). Direct `bd create --external-ref` is race-prone: `bd github
 * sync` can auto-create from labels, and a manual create after sync produces a
 * silent duplicate. This verb is idempotent — it scans existing bd records by
 * externalIssueNumber first and no-ops if the GH issue is already mirrored.
 *
 * Mirrors src/intake/intake-merge.ts: pure upstream-of-parity-chain CLI
 * plumbing, no XState events, no schema scaffolding. Triage labels (type/
 * priority/area) are out of scope — that's `prx triage promote`.
 *
 * Algorithm:
 *   1. resolve <gh-id> (must be GH-form, not bd)
 *   2. loadAllBeads → find record where externalIssueNumber matches (and URL
 *      prefix matches when --repo is non-default)
 *   3. if existing: log existing.id, return 0 (idempotent no-op — covers the
 *      sync-race acceptance bullet)
 *   4. fetch GH issue title via `gh issue view <n> --json title,url`
 *   5. if --dry-run: render planned argv, return 0
 *   6. execBd create --silent --external-ref <url> --title <title>
 *   7. parse stdout → log created bd id, return 0
 */

import { processEnv } from "@bounded-systems/env";
import { z } from "zod";

import { execBd, type BdExecResult } from "@bounded-systems/bd";
import { execGh, type GhExecResult } from "@bounded-systems/gh";
import { repoNameWithOwner as defaultRepoNameWithOwner } from "../pr-state/github.ts";
import {
  loadAllBeads as defaultLoadAllBeads,
  type BeadsRecord,
} from "../triage/triage.ts";
import { IntakeViewError, resolveIntakeViewId } from "./intake-id.ts";

export const intakeMirrorOptionsSchema = z.object({
  ghId: z.string().trim().min(1, "gh-id must not be empty"),
  repo: z.string().optional(),
  dryRun: z.boolean().default(false),
  format: z.enum(["plain", "json"]).default("plain"),
});

export type IntakeMirrorOptions = z.infer<typeof intakeMirrorOptionsSchema>;

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

export type IntakeMirrorRender = {
  ghNumber: number;
  repo?: string;
  issueUrl: string;
  title: string;
  bdCreate?: { argv: string[] };
  existingBdId?: string;
  createdBdId?: string;
  dryRun: boolean;
  exitCode: number;
};

export type IntakeMirrorDeps = {
  execGh?: typeof execGh;
  execBd?: typeof execBd;
  loadAllBeads?: typeof defaultLoadAllBeads;
  repoNameWithOwner?: typeof defaultRepoNameWithOwner;
  cwd?: () => string;
};

export class IntakeMirrorError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "IntakeMirrorError";
    this.exitCode = exitCode;
  }
}

const ISSUE_URL_PREFIX_RE =
  /^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/\d+/;

function extractRepoFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(ISSUE_URL_PREFIX_RE);
  return m ? m[1]! : null;
}

function composeIssueUrl(repo: string, ghNumber: number): string {
  return `https://github.com/${repo}/issues/${ghNumber}`;
}

function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  if (/^[A-Za-z0-9_/.:@=+\-#]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function renderArgvLine(args: string[]): string {
  return `bd ${args.map(shellQuote).join(" ")}`;
}

// Args after the `create` subcommand. `execBd` prepends the subcommand
// itself; for dry-run rendering we re-prepend it via renderBdCreateArgvLine.
function buildBdCreateArgs(issueUrl: string, title: string): string[] {
  return ["--silent", "--external-ref", issueUrl, "--title", title];
}

function renderBdCreateArgvLine(args: string[]): string {
  return renderArgvLine(["create", ...args]);
}

type GhIssueTitleAndUrl = { title: string; url: string };

function fetchGhTitle(
  ghNumber: number,
  repo: string | undefined,
  exec: typeof execGh,
): GhIssueTitleAndUrl {
  const args: string[] = [String(ghNumber), "--json", "title,url"];
  if (repo) {
    args.push("--repo", repo);
  }
  const result: GhExecResult = exec(
    {
      group: "issue",
      subcommand: "view",
      args,
      state: "planning",
      role: "planner",
    },
    processEnv(),
  );
  if (result.exitCode !== 0) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || "gh issue view failed";
    throw new IntakeMirrorError(
      `prx intake mirror: ${detail}`,
      result.exitCode || 1,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new IntakeMirrorError(
      "prx intake mirror: gh issue view --json returned invalid JSON",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new IntakeMirrorError(
      "prx intake mirror: gh issue view --json returned non-object",
    );
  }
  const r = parsed as Record<string, unknown>;
  const title = typeof r.title === "string" ? r.title : "";
  const url = typeof r.url === "string" ? r.url : "";
  if (!title) {
    throw new IntakeMirrorError(
      "prx intake mirror: gh issue view --json missing title",
    );
  }
  return { title, url };
}

function findExisting(
  records: BeadsRecord[],
  ghNumber: number,
  repo: string,
): BeadsRecord | null {
  // GH-2254: an issue number can carry more than one bd record when bd's
  // short-id recycling has left a closed phantom colliding on the live
  // canonical's pin. The idempotent no-op must bind to the *open* canonical,
  // not the closed phantom — otherwise `prx intake mirror` could report a
  // dead record as the mirror (and, worse, a future caller acting on the
  // returned id would mutate the wrong record). Prefer an open match; fall
  // back to the first match only when none is open.
  let firstMatch: BeadsRecord | null = null;
  for (const record of records) {
    if (record.externalIssueNumber !== ghNumber) continue;
    // When --repo is non-default we additionally compare repo prefixes to
    // avoid cross-repo collisions on the same issue number. (`repo` is always
    // resolved to a non-empty string before this is called.)
    const recRepo = extractRepoFromUrl(record.externalRef);
    if (recRepo !== null && recRepo !== repo) continue;
    if (record.status === "open") return record;
    if (firstMatch === null) firstMatch = record;
  }
  return firstMatch;
}

export function runIntakeMirror(
  opts: IntakeMirrorOptions,
  output: Output,
  deps: IntakeMirrorDeps = {},
): number {
  const ghExec = deps.execGh ?? execGh;
  const bdExec = deps.execBd ?? execBd;
  const loader = deps.loadAllBeads ?? defaultLoadAllBeads;
  const resolveRepo = deps.repoNameWithOwner ?? defaultRepoNameWithOwner;
  const getCwd = deps.cwd ?? process.cwd;

  let ghNumber: number;
  let resolvedRepo: string | undefined;
  try {
    const resolved = resolveIntakeViewId(opts.ghId);
    if (resolved.kind !== "gh") {
      const hint =
        resolved.kind === "notion"
          ? " (Notion ids are read-only via `prx scout notion`; bd mirroring from Notion is not yet wired)"
          : "";
      throw new IntakeMirrorError(
        `prx intake mirror: id must be a GitHub issue (GH-N, #N, N, or URL); got '${opts.ghId}'${hint}`,
      );
    }
    ghNumber = resolved.number;
    resolvedRepo = resolved.repo;
  } catch (err) {
    if (err instanceof IntakeMirrorError) {
      output.error(err.message);
      return err.exitCode;
    }
    if (err instanceof IntakeViewError) {
      output.error(
        err.message.replace(/^prx intake view:/, "prx intake mirror:"),
      );
      return err.exitCode;
    }
    throw err;
  }

  // Repo precedence: explicit --repo wins; URL form supplies it; else fall
  // back to the cwd's git remote (only call gh repo view when neither is set).
  let repo = opts.repo ?? resolvedRepo;
  if (!repo) {
    const looked = resolveRepo(getCwd()).trim();
    if (!looked) {
      output.error(
        "prx intake mirror: could not resolve cwd repo (gh repo view returned empty); pass --repo explicitly",
      );
      return 1;
    }
    repo = looked;
  }

  const issueUrl = composeIssueUrl(repo, ghNumber);

  // Step 1: dedup check — pre-create scan.
  let records: BeadsRecord[];
  try {
    records = loader(bdExec);
  } catch (err) {
    output.error(
      `prx intake mirror: ${(err as Error).message.replace(/^triage status: /, "")}`,
    );
    return 1;
  }
  const existing = findExisting(records, ghNumber, repo);
  if (existing) {
    const render: IntakeMirrorRender = {
      ghNumber,
      repo,
      issueUrl,
      title: existing.title,
      existingBdId: existing.id,
      dryRun: false,
      exitCode: 0,
    };
    output.log(formatIntakeMirrorRender(render, opts.format));
    return 0;
  }

  // Step 2: fetch title (only needed when we're actually going to create).
  let titleInfo: GhIssueTitleAndUrl;
  try {
    titleInfo = fetchGhTitle(ghNumber, repo, ghExec);
  } catch (err) {
    if (err instanceof IntakeMirrorError) {
      output.error(err.message);
      return err.exitCode;
    }
    throw err;
  }
  // Prefer gh's authoritative URL when present (handles edge cases like
  // enterprise installs); fall back to our composed URL.
  const canonicalUrl = titleInfo.url || issueUrl;
  const createArgs = buildBdCreateArgs(canonicalUrl, titleInfo.title);

  if (opts.dryRun) {
    const render: IntakeMirrorRender = {
      ghNumber,
      repo,
      issueUrl: canonicalUrl,
      title: titleInfo.title,
      bdCreate: { argv: createArgs },
      dryRun: true,
      exitCode: 0,
    };
    output.log(formatIntakeMirrorRender(render, opts.format));
    return 0;
  }

  // Step 3: bd create.
  const createResult: BdExecResult = bdExec(
    {
      subcommand: "create",
      args: createArgs,
      state: "planning",
      role: "planner",
    },
    processEnv(),
  );
  if (createResult.exitCode !== 0) {
    const detail =
      createResult.stderr.trim() ||
      createResult.stdout.trim() ||
      "bd create failed";
    output.error(`prx intake mirror: ${detail}`);
    return createResult.exitCode || 1;
  }

  // bd create --silent prints only the new id. Take the last non-empty line
  // to be tolerant of trailing newlines or stray status lines.
  const stdoutLines = createResult.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const createdBdId = stdoutLines[stdoutLines.length - 1] ?? "";
  if (!createdBdId) {
    output.error("prx intake mirror: bd create returned empty stdout");
    return 1;
  }

  const render: IntakeMirrorRender = {
    ghNumber,
    repo,
    issueUrl: canonicalUrl,
    title: titleInfo.title,
    bdCreate: { argv: createArgs },
    createdBdId,
    dryRun: false,
    exitCode: 0,
  };
  output.log(formatIntakeMirrorRender(render, opts.format));
  return 0;
}

export function formatIntakeMirrorRender(
  render: IntakeMirrorRender,
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(render, null, 2);
  }
  // Plain: when an existing bd record was found, emit just the bd id (the
  // operator usually pipes this into a follow-up `bd show`). Same shape for a
  // freshly-created record. Dry-run prints the planned argv block.
  if (render.dryRun) {
    const lines = [
      "prx intake mirror (dry-run)",
      `  gh:        GH-${render.ghNumber}`,
      `  repo:      ${render.repo ?? "(default — gh's git remote)"}`,
      `  url:       ${render.issueUrl}`,
      `  title:     ${render.title}`,
      `  would run:`,
    ];
    if (render.bdCreate) {
      lines.push(`    ${renderBdCreateArgvLine(render.bdCreate.argv)}`);
    }
    return lines.join("\n");
  }
  if (render.existingBdId) {
    return render.existingBdId;
  }
  if (render.createdBdId) {
    return render.createdBdId;
  }
  return "";
}
