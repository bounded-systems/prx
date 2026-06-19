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
import {
  buildBdIssueCloseArgs,
  execBdIssueClose,
  type BdIssueCloseResult,
} from "../tools/bd_issue_close.ts";
import { runBdShow, type BdShowResult } from "@bounded-systems/bd";
import { GH_PREFIX_RE, normalizeToBdSurfaceShort } from "../issues/resolver.ts";
import { loadIdentityConfig } from "../pr-state/github.ts";
import type { IdentityConfig } from "../pr-state/github.ts";
import { extractCanonicalRefs } from "./extract-refs.ts";
import { BD_SURFACE_LONG_ID_RE, decideRoute, missingPinHint } from "../repo_router/index.ts";
import {
  loadRepoInventoryConfig,
  loadRepoInventoryIndex,
  localWorkspacePrefixForCwd,
} from "../pr-state/repos.ts";

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
  | { kind: "error"; number: number; detail: string }
  | { kind: "closed-bd"; id: string; closeArgv: string[] }
  | { kind: "skip:bd-already-closed"; id: string }
  | { kind: "skip:bd-unrecognized"; raw: string }
  // GH-1806: bd long-id whose embedded workspace prefix is pinned to a
  // different LocalRepo in `.prx/repos/index.json`. Postmerge owns the local
  // worktree only; the operator reruns postmerge from the foreign worktree.
  | {
      kind: "skip:bd-foreign-workspace";
      raw: string;
      prefix: string;
      repo: string;
    }
  // GH-1806: bd long-id whose embedded workspace prefix has no inventory pin.
  // Payload carries the structured hint from `missingPinHint` (ADR §6).
  | { kind: "skip:bd-missing-pin"; raw: string; prefix: string; hint: string }
  | { kind: "error-bd"; id: string; detail: string };

export type PostmergeRender = {
  prNumber: number;
  repo?: string | undefined;
  state: "OPEN" | "CLOSED" | "MERGED";
  mergedAt: string | null;
  extracted: string[];
  closingIssuesReferences: number[];
  candidates: number[];
  bdCandidates: string[];
  targets: PostmergeTargetResult[];
  prViewArgv: string[];
  dryRun: boolean;
  exitCode: number;
};

export type PostmergeDeps = {
  execGh?: typeof execGh;
  execGhIssueClose?: typeof execGhIssueClose;
  execGhPrView?: typeof execGhPrView;
  execBdIssueClose?: typeof execBdIssueClose;
  runBdShow?: typeof runBdShow;
  loadIdentityConfig?: (repoPath: string) => IdentityConfig;
  // GH-1806: cross-workspace bd ref classification deps. Same DI-by-dep
  // idiom as `loadIdentityConfig` above; mirrors `RunRepoRouterDeps`.
  loadRepoInventoryConfig?: typeof loadRepoInventoryConfig;
  loadRepoInventoryIndex?: typeof loadRepoInventoryIndex;
  localWorkspacePrefixForCwd?: typeof localWorkspacePrefixForCwd;
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

type BdRefCandidate = {
  raw: string;
  normalized: string | null;
  // GH-1806: lowercase workspace slug parsed from `BD-<prefix>-<tail>` long-ids
  // via `BD_SURFACE_LONG_ID_RE`. `null` for short-form `BD-<8hex>` ids or
  // semantic-id refs that don't fit the long-id shape — those route through the
  // existing local-only flow.
  embeddedPrefix: string | null;
};

/**
 * Partition extracted refs into bd-canonical candidates.
 *
 * GH-N refs are handled by `ghOnlyRefsToNumbers`. Any remaining ref is a
 * potential bd id — `normalizeToBdSurfaceShort` resolves it to the canonical
 * `BD-<8hex>` short form when possible, or returns `null` (e.g. semantic-id
 * workspaces) which we surface as a skip target so the operator sees why the
 * ref was not actioned. The `embeddedPrefix` axis (GH-1806) carries the
 * workspace slug parsed from long-ids so `decideRoute` can classify them
 * cross-workspace before normalization collapses to the prefix-less short form.
 *
 * Dedup key keeps long-ids distinct from short-form ids so a foreign long-id
 * (added via the safety-net union scan) is not silently collapsed against a
 * colliding `BD-<8hex>` short ref that resolves to a different workspace.
 */
function bdRefCandidates(refs: string[]): BdRefCandidate[] {
  const seen = new Set<string>();
  const out: BdRefCandidate[] = [];
  for (const ref of refs) {
    if (ref.match(GH_PREFIX_RE)) continue;
    const longMatch = ref.match(BD_SURFACE_LONG_ID_RE);
    const embeddedPrefix = longMatch ? longMatch[1]! : null;
    const normalized = normalizeToBdSurfaceShort(ref);
    const key = (longMatch ? ref : (normalized ?? ref)).toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ raw: ref, normalized, embeddedPrefix });
  }
  return out;
}

/**
 * GH-1806 safety-net: a per-repo identity overlay that narrows
 * `canonicalIdPattern` (e.g. `canonical: "bd"` repos with a custom regex) can
 * filter out foreign-prefix BD long-ids before they reach `decideRoute`. Union
 * the overlay's extraction with a global `BD_SURFACE_LONG_ID_RE` re-scan so
 * the cross-workspace skip diagnostic stays visible even when the overlay
 * would otherwise hide the ref. Scoped to postmerge only — extraction for
 * `prx submit body-template` remains overlay-driven.
 */
function unionWithBdLongIdScan(blob: string, fromOverlay: string[]): string[] {
  const globalLongId = new RegExp(
    BD_SURFACE_LONG_ID_RE.source.replace(/^\^/, "").replace(/\$$/, ""),
    "gi",
  );
  const seen = new Set(fromOverlay.map((r) => r.toUpperCase()));
  const out = [...fromOverlay];
  for (const match of blob.matchAll(globalLongId)) {
    const raw = match[0];
    const key = raw.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
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
  const bdClose = deps.execBdIssueClose ?? execBdIssueClose;
  const bdShow = deps.runBdShow ?? runBdShow;
  const loadIdentity = deps.loadIdentityConfig ?? loadIdentityConfig;
  const loadInventoryConfig = deps.loadRepoInventoryConfig ?? loadRepoInventoryConfig;
  const loadInventoryIndex = deps.loadRepoInventoryIndex ?? loadRepoInventoryIndex;
  const localPrefixFor = deps.localWorkspacePrefixForCwd ?? localWorkspacePrefixForCwd;

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
  // GH-1806: union the overlay's extraction with a global BD long-id scan so
  // a narrowed per-repo overlay cannot hide a foreign-workspace long-id from
  // the cross-workspace skip diagnostic.
  const extracted = unionWithBdLongIdScan(blob, extractCanonicalRefs(blob, identity));
  const ghNumbers = ghOnlyRefsToNumbers(extracted);
  const autoClosed = new Set(view.closingIssuesReferences.map((r) => r.number));
  const candidates = ghNumbers.filter((n) => !autoClosed.has(n));
  const bdRefs = bdRefCandidates(extracted);
  const bdCandidates = bdRefs.map((c) => c.normalized).filter((id): id is string => id !== null);

  // GH-1806: read repo inventory + local workspace prefix once for the bd
  // close arm so `decideRoute` can classify each long-id ref against the same
  // routing seam `prx plan session --repo` uses (I-RR2: pin for the tick).
  const inventoryConfig = loadInventoryConfig(cwd);
  const inventory = inventoryConfig.indexPath
    ? loadInventoryIndex(inventoryConfig.indexPath)
    : null;
  const localPrefix = localPrefixFor(cwd);

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

  // Bd-canonical close loop (GH-1773): mirror the GH-N idempotent-close path
  // for any `Refs <bd-id>` lines extracted from the PR body. The pin-zero arm
  // documented at docs/architecture/bd-canonical-pr-linkage.md §2: no GH
  // auto-close projection fires, so postmerge owns the explicit `bd close`.
  for (const candidate of bdRefs) {
    // GH-1806: classify long-ids cross-workspace before touching the local bd
    // CLI. `decideRoute` resolves the embedded workspace prefix against the
    // repo inventory; foreign / missing-pin arms surface as actionable skips
    // so the operator reruns postmerge from the owning worktree (Option B).
    // Option A (auto-dispatch into the foreign worktree) is deferred until
    // `prx repo materialize` + `mainWorktree` resolution is wired into
    // postmerge callers — the classification seam here is the hand-off point.
    if (candidate.embeddedPrefix !== null) {
      const decision = decideRoute(candidate.raw, inventory, localPrefix);
      if (decision.kind === "foreign") {
        targets.push({
          kind: "skip:bd-foreign-workspace",
          raw: candidate.raw,
          prefix: decision.prefix,
          repo: decision.repo.name,
        });
        continue;
      }
      if (decision.kind === "missing-pin") {
        targets.push({
          kind: "skip:bd-missing-pin",
          raw: candidate.raw,
          prefix: decision.prefix,
          hint: missingPinHint(decision.prefix),
        });
        continue;
      }
      // `local` and `unrecognized` fall through to the existing path —
      // `local` is in this worktree; `unrecognized` cannot happen here
      // because the embeddedPrefix check matched a long-id.
    }

    if (candidate.normalized === null) {
      targets.push({ kind: "skip:bd-unrecognized", raw: candidate.raw });
      continue;
    }
    const bdId = candidate.normalized;
    const closeArgs = buildBdIssueCloseArgs({ id: bdId });

    if (opts.dryRun) {
      targets.push({ kind: "closed-bd", id: bdId, closeArgv: closeArgs });
      continue;
    }

    const showResult: BdShowResult = bdShow(bdId, cwd);
    if (!showResult.ok) {
      const detail = showResult.stderr.trim() || showResult.stdout.trim() || "bd show failed";
      targets.push({ kind: "error-bd", id: bdId, detail });
      hadError = true;
      continue;
    }
    if (showResult.record.status.toLowerCase() === "closed") {
      targets.push({ kind: "skip:bd-already-closed", id: bdId });
      continue;
    }

    const closeResult: BdIssueCloseResult = bdClose({ id: bdId, cwd });
    if (closeResult.exitCode !== 0) {
      const detail = closeResult.stderr.trim() || closeResult.stdout.trim() || "bd close failed";
      targets.push({ kind: "error-bd", id: bdId, detail });
      hadError = true;
      continue;
    }

    targets.push({ kind: "closed-bd", id: bdId, closeArgv: closeArgs });
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
    bdCandidates,
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
    `  bd candidates:       ${render.bdCandidates.length === 0 ? "(none)" : render.bdCandidates.join(", ")}`,
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
    } else if (t.kind === "error") {
      lines.push(`  - GH-${t.number}: ERROR — ${t.detail}`);
    } else if (t.kind === "closed-bd") {
      const tag = render.dryRun ? "would close" : "closed";
      lines.push(`  - ${t.id}: ${tag}`);
      if (render.dryRun) {
        lines.push(`      bd ${t.closeArgv.join(" ")}`);
      }
    } else if (t.kind === "skip:bd-already-closed") {
      lines.push(`  - ${t.id}: skip (bd record already closed)`);
    } else if (t.kind === "skip:bd-unrecognized") {
      lines.push(
        `  - ${t.raw}: skip (no BD-<8hex> short form — semantic-id workspaces unsupported)`,
      );
    } else if (t.kind === "skip:bd-foreign-workspace") {
      lines.push(
        `  - ${t.raw}: skip (foreign workspace "${t.prefix}" pinned to ${t.repo}; rerun postmerge in that repo's worktree)`,
      );
    } else if (t.kind === "skip:bd-missing-pin") {
      lines.push(
        `  - ${t.raw}: skip (workspace prefix "${t.prefix}" is not pinned in .prx/repos/index.json)`,
      );
      for (const hintLine of t.hint.split("\n")) {
        lines.push(`      ${hintLine}`);
      }
    } else {
      lines.push(`  - ${t.id}: ERROR — ${t.detail}`);
    }
  }
  lines.push(`  exit:                ${render.exitCode}`);
  return lines.join("\n");
}

export { DEFAULT_COMMENT_TEMPLATE };
