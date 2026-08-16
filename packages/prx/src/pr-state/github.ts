import { getEnv, processEnv } from "@bounded-systems/env";
import { operatorConfigRoot } from "../operator-config.ts";
import { DOLT_DATABASE_NAME_PATTERN } from "../dolt/schema.ts";
import { createHash } from "node:crypto";
import { runCaptured } from "@bounded-systems/proc";
import { resolveRepoRoot } from "@bounded-systems/repo-root";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homeDir, tmpDir } from "@bounded-systems/host";
import { z } from "zod";

import {
  canonicalWorkUnitIdFromBranchName,
  canonicalWorkUnitIdPattern,
  normalizeCanonicalWorkUnitId,
} from "../machine/work_unit.ts";
import {
  deriveInfo,
  ensurePrState,
  loadContract,
  type Contract,
  type StateMode,
} from "./contract.ts";
import { loadTaskContract, taskContractExists } from "./task.ts";
import { hostSegmentForHost, parseRepoUrl } from "./repos.ts";
import { classify, type Disposition } from "@bounded-systems/disposition";
// GH-1966: issue-parity type ontology relocated to a concern-grouped
// sub-package. Runtime values (consts/functions) still live here.
import type {
  BoardSnapshot,
  BoardSnapshotUnit,
  PrefixRoutingConfig,
  SurfaceSyncAction,
  SurfaceSyncAuthority,
  SurfaceSyncConfig,
  SurfaceSyncFeature,
  SurfaceSyncAuthorityFeature,
  SurfaceSyncMode,
  SurfaceSyncResult,
  SurfaceSyncScope,
} from "@bounded-systems/surface-sync";
import {
  computeSurfaceSync,
  issueParityFeatureEnabled,
  issueFeatureForUnit,
  issueFeatureStatus,
  normalizeIssueStatus,
} from "@bounded-systems/surface-sync";
// Re-export the routing primitives (relocated to surface-sync) so existing
// importers that reach for them via this module keep working.
export { resolveFeatureForPrefix } from "@bounded-systems/surface-sync";
export type { PrefixRoutingConfig } from "@bounded-systems/surface-sync";
import { runBeadsSync } from "../sync/run.ts";
import { DEFAULT_SYNC_LIMIT } from "../sync/limits.ts";
import { withBucketGate } from "@bounded-systems/github-budget";
import { classifyTraceCmd, traceEnabled, traceSync } from "./trace.ts";
import { getUnit, ProjectionMiss, projectionBypass, putUnit } from "./projection.ts";

export type PrSignalInfo = {
  reviewAdded: boolean;
  reviewApproved: boolean;
  agentReview: boolean;
  humanReview: boolean;
  commentsResolved: boolean;
  mergeStateStatus?: string | null;
  mergeable?: string | null;
  autoMergeEnabled: boolean;
};

export type PrReviewComment = {
  authorLogin: string | null;
  body: string;
  path: string | null;
  state: string | null;
  createdAt: string;
  url: string;
  outdated: boolean;
};

export type PrReviewThread = {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  comments: PrReviewComment[];
};

export type PrReviewThreadResolution = {
  id: string;
  isResolved: boolean;
};

export type PrAutoMergeRequest = {
  enabledBy: string | null;
  mergeMethod: "MERGE" | "SQUASH" | "REBASE";
};

export type PrCommentsResult = {
  repoPath: string;
  pr: {
    number: number;
    title: string;
    url: string;
    isDraft: boolean;
    baseRefName: string;
    reviewDecision: string | null;
    mergeStateStatus: string | null;
    mergeable: string | null;
    autoMergeEnabled: boolean;
    // GH-885: structured autoMergeRequest payload for the doctor actor.
    // Null when GitHub holds no automerge request for this PR. Optional so
    // older code paths that build mock PrCommentsResult fixtures don't have
    // to add this field in lockstep.
    autoMergeRequest?: PrAutoMergeRequest | null;
  };
  reviewAdded: boolean;
  reviewApproved: boolean;
  agentReview: boolean;
  humanReview: boolean;
  unresolvedThreads: number;
  threads: PrReviewThread[];
};

export type OpenPr = {
  number: number;
  headRefName: string;
  title: string;
  isDraft: boolean;
  url: string;
  reviewDecision?: string | null;
  statusCheckRollup?:
    | Array<{ status?: string | null; conclusion?: string | null }>
    | {
        state?: string | null;
        contexts?: Array<{ status?: string | null; conclusion?: string | null }> | null;
      }
    | null;
  mergeable?: string | null;
  reviews?:
    | Array<{ state?: string | null }>
    | { nodes?: Array<{ state?: string | null }> | null }
    | null;
};

export type CommandResult = {
  stdout: string;
  stderr: string;
  status: number;
};

export type WorktreeRemoveResult = {
  repoPath: string;
  target: string;
  path: string;
  resolvedPath: string;
  branch: string | null;
  force: boolean;
  prune: boolean;
  deleteBranch: boolean;
  dryRun: boolean;
  removed: boolean;
  branchDeleted: boolean;
};

export type ListedWorktree = {
  path: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  locked: boolean;
  lockReason: string | null;
};

export type PidAliveProbe = (pid: number) => boolean;

/**
 * Extracts the pid from the canonical session-lock reason written by
 * `prx session open` (format: `prx session runtime active for <id> (pid <N>)`).
 * The regex is anchored to the full prx-owned format so foreign locks whose
 * reason happens to contain `(pid N)` are not treated as reclaim-eligible.
 * Returns null when the reason isn't a prx-owned session lock.
 */
export function parseSessionLockPid(reason: string | null | undefined): number | null {
  if (!reason) return null;
  const match = reason.match(/^prx session runtime active for .+ \(pid (\d+)\)$/);
  if (!match) return null;
  const pid = Number.parseInt(match[1]!, 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

/**
 * Fails open: only treat `ESRCH` as conclusive evidence that the pid is gone.
 * Any other error (including `EPERM`, transient OS quirks, or non-Error
 * values) is interpreted as "probably alive" so we never reclaim a lock we're
 * uncertain about.
 */
export const defaultPidAliveProbe: PidAliveProbe = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code !== "ESRCH";
  }
};

export type ProtectMainBackend = "branch-protection" | "ruleset";

export type CommandRunner = (
  cmd: string[],
  options?: { cwd?: string; check?: boolean; env?: NodeJS.ProcessEnv; repoRoot?: string },
) => CommandResult;

export type RenderRunner = (contractPath: string, outputPath: string) => void;

/**
 * Raw subprocess-backed runner with no rate-limit awareness. Exposed so the
 * `gh api rate_limit` budget refresh in `@bounded-systems/github-budget` can probe
 * without recursing through the gate, and so tests can opt out.
 *
 * Production callers should use `defaultRunner`, which wraps this with
 * `withBucketGate` (GH-1141).
 */
export const rawDefaultRunner: CommandRunner = (cmd, options = {}) => {
  // The spawnCapture-backed capture + error/check semantics (GH-1609 temp-file
  // streaming, faithful ENOENT/ETIMEDOUT surfacing) now live in @bounded-systems/proc's
  // runCaptured. This runner only layers the command-specific env shaping
  // (bd/tmux, repoRoot) on top before delegating.
  return runCaptured(cmd, {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    env: commandEnv(cmd, options.env, { repoRoot: options.repoRoot }),
    ...(options.check !== undefined ? { check: options.check } : {}),
  });
};

/**
 * GH-2074 PR-1 (.1.4): the `PRX_TRACE` measurement wedge. Wraps a runner so
 * every command that crosses the seam emits one JSONL `{ts,kind,target,ms}`
 * record to stderr — covering all four `boardStatus` passes from the single
 * `defaultRunner` thread (per the `.1.2` validation). `cache` is `"n/a"` here;
 * the cache layers (`wtStatus`/`remoteStatus`) own their own hit/miss emits.
 * When `PRX_TRACE` is unset/"0", `traceSync` early-returns the call with zero
 * added work, so the default hot path is unchanged.
 *
 * GH-2355 fidelity fix: `withTrace` wraps `rawDefaultRunner` *inside*
 * `withBucketGate` (see `defaultRunner`), so the measured `ms` is the subprocess
 * exec only. The gh rate-limit gate-wait (`gateGhArgv`, which `withBucketGate`
 * runs *before* its inner runner) is therefore excluded — the original PR-1
 * order `withTrace(withBucketGate(...))` folded that wait into every gated
 * command's `ms`. Emitting the gate-wait as its own span is a follow-up
 * (ai-home-4wps9).
 */
export function withTrace(runner: CommandRunner): CommandRunner {
  return (cmd, options) => {
    if (!traceEnabled()) return runner(cmd, options);
    const { kind, target } = classifyTraceCmd(cmd);
    return traceSync(kind, target, () => runner(cmd, options));
  };
}

// withTrace is the INNERMOST wrap (exec-only ms); withBucketGate gates around
// it (its gate-wait is not traced). The rate_limit probe (`rawRunner`) calls
// rawDefaultRunner directly, so the probe itself stays untraced.
export const defaultRunner: CommandRunner = withBucketGate(withTrace(rawDefaultRunner), {
  rawRunner: (cmd) => rawDefaultRunner(cmd, { check: false }),
});

function commandBinaryName(cmd: string[]): string {
  const file = cmd[0] ?? "";
  const idx = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  return idx >= 0 ? file.slice(idx + 1) : file;
}

export function commandEnv(
  cmd: string[],
  env: NodeJS.ProcessEnv = processEnv(),
  _options?: { repoRoot?: string | undefined },
): NodeJS.ProcessEnv {
  const needsBd = cmd[0] === "bd";
  const needsTmux = commandBinaryName(cmd) === "tmux";
  if (!needsBd && !needsTmux) {
    return env;
  }
  const nextEnv = { ...env };
  if (needsBd) {
    delete nextEnv.BEADS_DIR;
  }
  if (needsTmux) {
    // A tmux invocation may spawn the `-L prx` server, which inherits this
    // env and keeps it for the lifetime of the server. `bun test` preload
    // (test/preload.ts) rewrites TMPDIR to <repoRoot>/.tmp/bun-tests to keep
    // tests hermetic; if prx is reached from inside a test and ends up
    // spawning the server, that path gets baked in — and when the worktree
    // is later removed, every pane in the still-alive server inherits a
    // dead TMPDIR and every mktemp-using tool (e.g. tirith) ENOENTs. See
    // GH-743.
    delete nextEnv.TMPDIR;
    delete nextEnv.TMP;
    delete nextEnv.TEMP;
    delete nextEnv.TIRITH_SESSION_ID;
  }
  return nextEnv;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const repoRootPath = fileURLToPath(new URL("../../../../", import.meta.url));
const renderScriptPath = join(
  repoRootPath,
  "skills",
  "pr-contract",
  "scripts",
  "render_pr_body.ts",
);

export const defaultRenderRunner: RenderRunner = (contractPath, outputPath) => {
  defaultRunner([
    "bun",
    renderScriptPath,
    contractPath,
    "--output",
    outputPath,
    "--emit-hook-block",
  ]);
};

export function repoRoot(path: string, runner: CommandRunner = defaultRunner): string {
  return resolveRepoRoot(path, runner);
}

export function currentBranchName(
  repoPath: string,
  runner: CommandRunner = defaultRunner,
): string | null {
  try {
    const result = runner(["git", "-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"]);
    const name = result.stdout.trim();
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

function isAgentReviewerLogin(login: string | null | undefined): boolean {
  if (!login) {
    return false;
  }
  return /-pull-request-reviewer$/i.test(login);
}

export type ReviewConfig = {
  requireCommentsResolved: boolean;
  requireAgentReview: boolean;
  requireHumanReview: boolean;
  requireAutoMergeEnabled: boolean;
};

export const defaultReviewConfig: ReviewConfig = {
  requireCommentsResolved: true,
  requireAgentReview: true,
  requireHumanReview: true,
  requireAutoMergeEnabled: false,
};

const reviewNodeSchema = z
  .object({
    state: z.string().nullable().optional(),
    author: z
      .object({
        login: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
  })
  .passthrough();

// GH-885: doctor actor reads enabledBy + mergeMethod off the autoMergeRequest
// payload so it can render which method is armed and credit the operator who
// armed it. Both fields can be missing on older payloads (gh, GHES) or null
// when GitHub hasn't populated them yet.
const prAutoMergeRequestSchema = z
  .object({
    enabledBy: z
      .object({
        login: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
    mergeMethod: z.enum(["MERGE", "SQUASH", "REBASE"]).nullable().optional(),
  })
  .passthrough();

const prCommentsSummarySchema = z
  .object({
    number: z.number().int(),
    title: z.string(),
    url: z.string(),
    isDraft: z.boolean(),
    baseRefName: z.string(),
    reviewDecision: z.string().nullable().optional(),
    mergeStateStatus: z.string().nullable().optional(),
    mergeable: z.string().nullable().optional(),
    autoMergeRequest: prAutoMergeRequestSchema.nullable().optional(),
    reviews: z
      .union([
        z.array(reviewNodeSchema),
        z
          .object({
            nodes: z.array(reviewNodeSchema).nullable().optional(),
          })
          .strict(),
        z.null(),
      ])
      .optional(),
  })
  .strict();

const prReviewCommentNodeSchema = z
  .object({
    author: z
      .object({
        login: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
    body: z.string(),
    state: z.string().nullable().optional(),
    path: z.string().nullable().optional(),
    createdAt: z.string(),
    url: z.string(),
    outdated: z.boolean().optional(),
  })
  .strict();

const prReviewThreadNodeSchema = z
  .object({
    id: z.string(),
    isResolved: z.boolean(),
    isOutdated: z.boolean(),
    path: z.string().nullable().optional(),
    comments: z
      .object({
        nodes: z.array(prReviewCommentNodeSchema),
      })
      .strict(),
  })
  .strict();

const prReviewThreadsResponseSchema = z
  .object({
    data: z
      .object({
        repository: z
          .object({
            pullRequest: z
              .object({
                reviewThreads: z
                  .object({
                    nodes: z.array(prReviewThreadNodeSchema),
                  })
                  .strict(),
              })
              .nullable(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

const resolveReviewThreadResponseSchema = z
  .object({
    data: z
      .object({
        resolveReviewThread: z
          .object({
            thread: z
              .object({
                isResolved: z.boolean(),
              })
              .strict(),
          })
          .nullable(),
      })
      .strict(),
  })
  .strict();

function normalizeReviewNodes(
  reviewsRaw: z.infer<typeof prCommentsSummarySchema>["reviews"],
): Array<z.infer<typeof reviewNodeSchema>> {
  if (Array.isArray(reviewsRaw)) {
    return reviewsRaw;
  }
  if (
    reviewsRaw &&
    typeof reviewsRaw === "object" &&
    "nodes" in reviewsRaw &&
    Array.isArray(reviewsRaw.nodes)
  ) {
    return reviewsRaw.nodes;
  }
  return [];
}

function splitRepoNameWithOwner(nameWithOwner: string): { owner: string; repo: string } {
  const [owner, repo] = nameWithOwner.split("/", 2);
  if (!owner || !repo) {
    throw new Error(`Invalid repository nameWithOwner: ${nameWithOwner}`);
  }
  return { owner, repo };
}

export function loadReviewConfig(
  repoPath: string,
  runner: CommandRunner = defaultRunner,
): ReviewConfig {
  const configPath = join(repoPath, "prx.toml");
  if (!existsSync(configPath)) {
    return defaultReviewConfig;
  }

  const parsed: ReviewConfig = { ...defaultReviewConfig };
  let section = "";
  for (const rawLine of readFileSync(configPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const sectionMatch = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1] ?? "";
      continue;
    }
    if (section !== "review") {
      continue;
    }
    const keyMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!keyMatch) {
      continue;
    }
    const key = keyMatch[1];
    const value = parseBooleanTomlValue(keyMatch[2] ?? "");
    if (value === null) {
      continue;
    }
    if (key === "require_comments_resolved") {
      parsed.requireCommentsResolved = value;
      continue;
    }
    if (key === "require_agent_review") {
      parsed.requireAgentReview = value;
      continue;
    }
    if (key === "require_human_review") {
      parsed.requireHumanReview = value;
      continue;
    }
    if (key === "require_auto_merge_enabled") {
      parsed.requireAutoMergeEnabled = value;
      continue;
    }
  }

  return parsed;
}

export function fetchPrSignalInfo(
  repoPath: string,
  prRef: string,
  runner: CommandRunner = defaultRunner,
): PrSignalInfo | null {
  try {
    const review = fetchPrComments(repoPath, prRef, runner);
    return {
      reviewAdded: review.reviewAdded,
      reviewApproved: review.reviewApproved,
      agentReview: review.agentReview,
      humanReview: review.humanReview,
      commentsResolved: review.unresolvedThreads === 0,
      mergeStateStatus: review.pr.mergeStateStatus,
      mergeable: review.pr.mergeable,
      autoMergeEnabled: review.pr.autoMergeEnabled,
    };
  } catch {
    return null;
  }
}

export function fetchPrComments(
  repoPath: string,
  prRef?: string,
  runner: CommandRunner = defaultRunner,
): PrCommentsResult {
  const summaryCommand = ["gh", "pr", "view"];
  if (prRef) {
    summaryCommand.push(prRef);
  }
  summaryCommand.push(
    "--json",
    "number,title,url,isDraft,baseRefName,reviewDecision,mergeStateStatus,mergeable,autoMergeRequest,reviews",
  );
  const summary = prCommentsSummarySchema.parse(
    JSON.parse(runner(summaryCommand, { cwd: repoPath }).stdout),
  );
  const reviews = normalizeReviewNodes(summary.reviews);
  const { owner, repo } = splitRepoNameWithOwner(repoNameWithOwner(repoPath, runner));
  const threadsResponse = prReviewThreadsResponseSchema.parse(
    JSON.parse(
      runner(
        [
          "gh",
          "api",
          "graphql",
          "-f",
          "query=query($owner:String!, $repo:String!, $number:Int!) { repository(owner:$owner, name:$repo) { pullRequest(number:$number) { reviewThreads(first:100) { nodes { id isResolved isOutdated path comments(first:20) { nodes { author { login } body state path createdAt url outdated } } } } } } }",
          "-F",
          `owner=${owner}`,
          "-F",
          `repo=${repo}`,
          "-F",
          `number=${summary.number}`,
        ],
        { cwd: repoPath },
      ).stdout,
    ),
  );
  const pullRequest = threadsResponse.data.repository.pullRequest;
  if (!pullRequest) {
    throw new Error(`Could not resolve pull request #${summary.number} in ${owner}/${repo}`);
  }
  const threads = pullRequest.reviewThreads.nodes.map((thread) => ({
    id: thread.id,
    isResolved: thread.isResolved,
    isOutdated: thread.isOutdated,
    path: thread.path ?? null,
    comments: thread.comments.nodes.map((comment) => ({
      authorLogin: comment.author?.login ?? null,
      body: comment.body,
      path: comment.path ?? null,
      state: comment.state ?? null,
      createdAt: comment.createdAt,
      url: comment.url,
      outdated: comment.outdated ?? false,
    })),
  }));
  // GH-885: structured autoMergeRequest projection for the doctor actor.
  // Default mergeMethod to SQUASH when GitHub hasn't surfaced one — matches the
  // doctor merge default and avoids forcing every consumer to handle the gap.
  let autoMergeRequest: PrAutoMergeRequest | null = null;
  if (summary.autoMergeRequest) {
    autoMergeRequest = {
      enabledBy: summary.autoMergeRequest.enabledBy?.login ?? null,
      mergeMethod: summary.autoMergeRequest.mergeMethod ?? "SQUASH",
    };
  }

  return {
    repoPath,
    pr: {
      number: summary.number,
      title: summary.title,
      url: summary.url,
      isDraft: summary.isDraft,
      baseRefName: summary.baseRefName,
      reviewDecision: summary.reviewDecision ?? null,
      mergeStateStatus: summary.mergeStateStatus ?? null,
      mergeable: summary.mergeable ?? null,
      autoMergeEnabled: Boolean(summary.autoMergeRequest),
      autoMergeRequest,
    },
    reviewAdded: reviews.length > 0,
    reviewApproved: reviews.some((review) => review.state === "APPROVED"),
    agentReview: reviews.some((review) => isAgentReviewerLogin(review.author?.login ?? null)),
    humanReview: reviews.some(
      (review) => !!review.author?.login && !isAgentReviewerLogin(review.author.login),
    ),
    unresolvedThreads: threads.filter((thread) => !thread.isResolved).length,
    threads,
  };
}

export function resolvePrReviewThreads(
  repoPath: string,
  threadIds: string[],
  runner: CommandRunner = defaultRunner,
): PrReviewThreadResolution[] {
  const uniqueThreadIds = [
    ...new Set(
      threadIds.map((threadId) => threadId.trim()).filter((threadId) => threadId.length > 0),
    ),
  ];
  if (uniqueThreadIds.length === 0) {
    return [];
  }

  return uniqueThreadIds.map((threadId) => {
    const response = resolveReviewThreadResponseSchema.parse(
      JSON.parse(
        runner(
          [
            "gh",
            "api",
            "graphql",
            "-f",
            "query=mutation($id:ID!) { resolveReviewThread(input:{threadId:$id}) { thread { isResolved } } }",
            "-F",
            `id=${threadId}`,
          ],
          { cwd: repoPath },
        ).stdout,
      ),
    );

    return {
      id: threadId,
      isResolved: response.data.resolveReviewThread?.thread.isResolved ?? false,
    };
  });
}

// GH-885: GraphQL helpers used by the doctor actor for guarded transitions.
// The executor profile blocks `Bash(gh pr merge:*)` at the flag layer; these
// helpers go through `gh api graphql` (allowed) to call the same mutations.

const resolvePrNodeIdResponseSchema = z
  .object({
    data: z
      .object({
        repository: z
          .object({
            pullRequest: z
              .object({
                id: z.string(),
              })
              .nullable(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

const enableAutoMergeResponseSchema = z
  .object({
    data: z
      .object({
        enablePullRequestAutoMerge: z
          .object({
            pullRequest: z
              .object({
                id: z.string(),
                autoMergeRequest: z
                  .object({
                    enabledAt: z.string().nullable().optional(),
                    mergeMethod: z.enum(["MERGE", "SQUASH", "REBASE"]).nullable().optional(),
                  })
                  .nullable()
                  .optional(),
              })
              .nullable(),
          })
          .nullable(),
      })
      .strict(),
  })
  .strict();

const markPrReadyForReviewResponseSchema = z
  .object({
    data: z
      .object({
        markPullRequestReadyForReview: z
          .object({
            pullRequest: z
              .object({
                id: z.string(),
                isDraft: z.boolean(),
              })
              .nullable(),
          })
          .nullable(),
      })
      .strict(),
  })
  .strict();

const convertPrToDraftResponseSchema = z
  .object({
    data: z
      .object({
        convertPullRequestToDraft: z
          .object({
            pullRequest: z
              .object({
                id: z.string(),
                isDraft: z.boolean(),
              })
              .nullable(),
          })
          .nullable(),
      })
      .strict(),
  })
  .strict();

const mergePullRequestResponseSchema = z
  .object({
    data: z
      .object({
        mergePullRequest: z
          .object({
            pullRequest: z
              .object({
                id: z.string(),
                merged: z.boolean(),
                state: z.string(),
              })
              .nullable(),
          })
          .nullable(),
      })
      .strict(),
  })
  .strict();

export function resolvePrNodeId(
  repoPath: string,
  prNumber: number,
  runner: CommandRunner = defaultRunner,
): string {
  const { owner, repo } = splitRepoNameWithOwner(repoNameWithOwner(repoPath, runner));
  const response = resolvePrNodeIdResponseSchema.parse(
    JSON.parse(
      runner(
        [
          "gh",
          "api",
          "graphql",
          "-f",
          "query=query($owner:String!, $repo:String!, $number:Int!) { repository(owner:$owner, name:$repo) { pullRequest(number:$number) { id } } }",
          "-F",
          `owner=${owner}`,
          "-F",
          `repo=${repo}`,
          "-F",
          `number=${prNumber}`,
        ],
        { cwd: repoPath },
      ).stdout,
    ),
  );
  const pullRequest = response.data.repository.pullRequest;
  if (!pullRequest) {
    throw new Error(`Could not resolve pull request #${prNumber} in ${owner}/${repo}`);
  }
  return pullRequest.id;
}

export type EnableAutoMergeResult = {
  prNodeId: string;
  mergeMethod: "MERGE" | "SQUASH" | "REBASE";
};

export function enableAutoMerge(
  repoPath: string,
  prNodeId: string,
  mergeMethod: "MERGE" | "SQUASH" | "REBASE",
  runner: CommandRunner = defaultRunner,
): EnableAutoMergeResult {
  const response = enableAutoMergeResponseSchema.parse(
    JSON.parse(
      runner(
        [
          "gh",
          "api",
          "graphql",
          "-f",
          "query=mutation($id:ID!, $method:PullRequestMergeMethod!) { enablePullRequestAutoMerge(input:{pullRequestId:$id, mergeMethod:$method}) { pullRequest { id autoMergeRequest { enabledAt mergeMethod } } } }",
          "-F",
          `id=${prNodeId}`,
          "-F",
          `method=${mergeMethod}`,
        ],
        { cwd: repoPath },
      ).stdout,
    ),
  );
  const pullRequest = response.data.enablePullRequestAutoMerge?.pullRequest;
  if (!pullRequest) {
    throw new Error(`enablePullRequestAutoMerge returned no pull request for ${prNodeId}`);
  }
  return {
    prNodeId: pullRequest.id,
    mergeMethod: pullRequest.autoMergeRequest?.mergeMethod ?? mergeMethod,
  };
}

export type PrReadyResult = { prNodeId: string; isDraft: boolean };

export function markPrReadyForReview(
  repoPath: string,
  prNodeId: string,
  runner: CommandRunner = defaultRunner,
): PrReadyResult {
  const response = markPrReadyForReviewResponseSchema.parse(
    JSON.parse(
      runner(
        [
          "gh",
          "api",
          "graphql",
          "-f",
          "query=mutation($id:ID!) { markPullRequestReadyForReview(input:{pullRequestId:$id}) { pullRequest { id isDraft } } }",
          "-F",
          `id=${prNodeId}`,
        ],
        { cwd: repoPath },
      ).stdout,
    ),
  );
  const pullRequest = response.data.markPullRequestReadyForReview?.pullRequest;
  if (!pullRequest) {
    throw new Error(`markPullRequestReadyForReview returned no pull request for ${prNodeId}`);
  }
  return { prNodeId: pullRequest.id, isDraft: pullRequest.isDraft };
}

export type MergePullRequestResult = {
  prNodeId: string;
  merged: boolean;
  state: string;
};

export function mergePullRequest(
  repoPath: string,
  prNodeId: string,
  mergeMethod: "MERGE" | "SQUASH" | "REBASE",
  runner: CommandRunner = defaultRunner,
): MergePullRequestResult {
  const response = mergePullRequestResponseSchema.parse(
    JSON.parse(
      runner(
        [
          "gh",
          "api",
          "graphql",
          "-f",
          "query=mutation($id:ID!, $method:PullRequestMergeMethod!) { mergePullRequest(input:{pullRequestId:$id, mergeMethod:$method}) { pullRequest { id merged state } } }",
          "-F",
          `id=${prNodeId}`,
          "-F",
          `method=${mergeMethod}`,
        ],
        { cwd: repoPath },
      ).stdout,
    ),
  );
  const pullRequest = response.data.mergePullRequest?.pullRequest;
  if (!pullRequest) {
    throw new Error(`mergePullRequest returned no pull request for ${prNodeId}`);
  }
  return {
    prNodeId: pullRequest.id,
    merged: pullRequest.merged,
    state: pullRequest.state,
  };
}

export function convertPrToDraft(
  repoPath: string,
  prNodeId: string,
  runner: CommandRunner = defaultRunner,
): PrReadyResult {
  const response = convertPrToDraftResponseSchema.parse(
    JSON.parse(
      runner(
        [
          "gh",
          "api",
          "graphql",
          "-f",
          "query=mutation($id:ID!) { convertPullRequestToDraft(input:{pullRequestId:$id}) { pullRequest { id isDraft } } }",
          "-F",
          `id=${prNodeId}`,
        ],
        { cwd: repoPath },
      ).stdout,
    ),
  );
  const pullRequest = response.data.convertPullRequestToDraft?.pullRequest;
  if (!pullRequest) {
    throw new Error(`convertPullRequestToDraft returned no pull request for ${prNodeId}`);
  }
  return { prNodeId: pullRequest.id, isDraft: pullRequest.isDraft };
}

export function resolveCurrentPrRef(
  repoPath: string,
  runner: CommandRunner = defaultRunner,
): string {
  const result = runner(["gh", "pr", "view", "--json", "number", "--jq", ".number"], {
    cwd: repoPath,
  });
  const num = result.stdout.trim();
  if (!num) {
    throw new Error("No PR found for the current branch");
  }
  return num;
}

export function repoNameWithOwner(path: string, runner: CommandRunner = defaultRunner): string {
  const originUrl = readOriginUrl(path, runner);
  if (originUrl) {
    const slug = parseGithubRepo(originUrl);
    if (slug) {
      return slug;
    }
  }
  // Fallback: no origin / non-github host / fork-of-fork / gist remote. `gh`'s
  // own resolution handles those and errors the same way the old code did on a
  // repo with no usable remote (preserves the AC: same error / no origin).
  return runner(["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
    cwd: path,
  }).stdout.trim();
}

function readOriginUrl(path: string, runner: CommandRunner): string | null {
  try {
    const out = runner(["git", "-C", path, "remote", "get-url", "origin"], {
      check: false,
    }).stdout.trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export function viewerLogin(runner: CommandRunner = defaultRunner): string {
  return runner(["gh", "api", "user", "--jq", ".login"]).stdout.trim();
}

function repoOwnerType(repo: string, runner: CommandRunner = defaultRunner): string {
  return runner(["gh", "api", `repos/${repo}`, "--jq", ".owner.type"]).stdout.trim();
}

const branchProtectionAllowancesSchema = z.object({
  users: z.array(z.string()),
  teams: z.array(z.string()),
  apps: z.array(z.string()),
});

const branchProtectionStatusChecksSchema = z.object({
  strict: z.boolean(),
  contexts: z.array(z.string()),
});

const branchProtectionReviewSchema = z.object({
  dismissal_restrictions: branchProtectionAllowancesSchema.optional(),
  dismiss_stale_reviews: z.boolean(),
  require_code_owner_reviews: z.boolean(),
  required_approving_review_count: z.number().int().min(0).max(6),
  require_last_push_approval: z.boolean(),
  bypass_pull_request_allowances: branchProtectionAllowancesSchema.optional(),
});

export const branchProtectionPayloadSchema = z.object({
  required_status_checks: z.union([z.null(), branchProtectionStatusChecksSchema]),
  enforce_admins: z.nullable(z.boolean()),
  required_pull_request_reviews: branchProtectionReviewSchema,
  restrictions: z.null(),
  required_linear_history: z.boolean(),
  allow_force_pushes: z.boolean(),
  allow_deletions: z.boolean(),
  block_creations: z.boolean(),
  required_conversation_resolution: z.boolean(),
  lock_branch: z.boolean(),
  allow_fork_syncing: z.boolean(),
});

export const branchProtectionSpecSchema = z.object({
  branch: z.string(),
  protection: branchProtectionPayloadSchema,
  required_signatures: z.boolean().optional(),
});

export const branchProtectionPayloadJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "required_status_checks",
    "enforce_admins",
    "required_pull_request_reviews",
    "restrictions",
    "required_linear_history",
    "allow_force_pushes",
    "allow_deletions",
    "block_creations",
    "required_conversation_resolution",
    "lock_branch",
    "allow_fork_syncing",
  ],
  properties: {
    required_status_checks: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["strict", "contexts"],
          properties: {
            strict: { type: "boolean" },
            contexts: { type: "array", items: { type: "string" } },
          },
        },
      ],
    },
    enforce_admins: { type: ["boolean", "null"] },
    required_pull_request_reviews: {
      type: "object",
      additionalProperties: false,
      required: [
        "dismiss_stale_reviews",
        "require_code_owner_reviews",
        "required_approving_review_count",
        "require_last_push_approval",
      ],
      properties: {
        dismissal_restrictions: {
          type: "object",
          additionalProperties: false,
          required: ["users", "teams", "apps"],
          properties: {
            users: { type: "array", items: { type: "string" } },
            teams: { type: "array", items: { type: "string" } },
            apps: { type: "array", items: { type: "string" } },
          },
        },
        dismiss_stale_reviews: { type: "boolean" },
        require_code_owner_reviews: { type: "boolean" },
        required_approving_review_count: { type: "integer", minimum: 0, maximum: 6 },
        require_last_push_approval: { type: "boolean" },
        bypass_pull_request_allowances: {
          type: "object",
          additionalProperties: false,
          required: ["users", "teams", "apps"],
          properties: {
            users: { type: "array", items: { type: "string" } },
            teams: { type: "array", items: { type: "string" } },
            apps: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
    restrictions: { type: "null" },
    required_linear_history: { type: "boolean" },
    allow_force_pushes: { type: "boolean" },
    allow_deletions: { type: "boolean" },
    block_creations: { type: "boolean" },
    required_conversation_resolution: { type: "boolean" },
    lock_branch: { type: "boolean" },
    allow_fork_syncing: { type: "boolean" },
  },
} as const;

export type ProtectMainBranchResult = {
  backend: ProtectMainBackend;
  repo: string;
  branch: string;
  viewer: string;
  owner: string;
  ownerType: string;
  rulesetId: number | null;
  rulesetName: string | null;
  solo: boolean;
  approvalContributorCount: number | null;
  requireLastPushApprovalSuppressed: boolean;
  requiredApprovingReviewCountSuppressed: boolean;
  apply: boolean;
  applied: boolean;
  enforceAdmins: boolean;
  requireConversationResolution: boolean;
  requireLastPushApproval: boolean;
  requiredApprovingReviewCount: number;
  requireLinearHistory: boolean;
  requiredStatusChecks: string[];
  payload: z.infer<typeof branchProtectionPayloadSchema>;
  command: string[];
};

export type ProtectMainBranchCheckResult = {
  backend: ProtectMainBackend;
  repo: string;
  branch: string;
  viewer: string;
  owner: string;
  ownerType: string;
  rulesetId: number | null;
  rulesetName: string | null;
  solo: boolean;
  approvalContributorCount: number | null;
  requireLastPushApprovalSuppressed: boolean;
  requiredApprovingReviewCountSuppressed: boolean;
  enforceAdmins: boolean;
  requireConversationResolution: boolean;
  requireLastPushApproval: boolean;
  requiredApprovingReviewCount: number;
  requireLinearHistory: boolean;
  requiredStatusChecks: string[];
  desired: z.infer<typeof branchProtectionPayloadSchema>;
  live: z.infer<typeof branchProtectionPayloadSchema>;
  matches: boolean;
};

export type RepoCheckNamesResult = {
  repo: string;
  branch: string;
  sha: string;
  checks: string[];
};

const rulesetRefNameConditionSchema = z.object({
  include: z.array(z.string()),
  exclude: z.array(z.string()).default([]),
});

const rulesetRuleSchema = z.object({
  type: z.string(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

const repositoryRulesetSchema = z.object({
  id: z.number().int().nonnegative(),
  name: z.string(),
  target: z.string(),
  enforcement: z.string(),
  bypass_actors: z.array(z.unknown()).default([]),
  conditions: z.object({
    ref_name: rulesetRefNameConditionSchema,
  }),
  rules: z.array(rulesetRuleSchema),
});

const repositoryRulesetSummarySchema = z.object({
  id: z.number().int().nonnegative(),
  name: z.string(),
  target: z.string(),
});

function loadBranchProtectionSpec(
  repoPath: string,
  branch: string,
  runner: CommandRunner = defaultRunner,
): z.infer<typeof branchProtectionSpecSchema> | null {
  const root = repoRoot(repoPath, runner);
  const specPath = join(root, ".prx", "branch_protection", `${branch}.json`);
  if (!existsSync(specPath)) {
    return null;
  }
  return branchProtectionSpecSchema.parse(JSON.parse(readFileSync(specPath, "utf8")));
}

function desiredBranchProtectionPayload(
  ownerType: string,
  options: {
    enforceAdmins?: boolean | undefined;
    requireConversationResolution?: boolean | undefined;
    requireLastPushApproval?: boolean | undefined;
    requireLinearHistory?: boolean | undefined;
    requiredStatusChecks?: string[] | undefined;
  } = {},
  basePayload?: z.infer<typeof branchProtectionPayloadSchema>,
): z.infer<typeof branchProtectionPayloadSchema> {
  const isOrganizationRepo = ownerType === "Organization";
  const base =
    basePayload ??
    branchProtectionPayloadSchema.parse({
      required_status_checks: null,
      enforce_admins: null,
      required_pull_request_reviews: {
        ...(isOrganizationRepo
          ? {
              dismissal_restrictions: {
                users: [],
                teams: [],
                apps: [],
              },
            }
          : {}),
        dismiss_stale_reviews: true,
        require_code_owner_reviews: false,
        required_approving_review_count: 1,
        require_last_push_approval: false,
        ...(isOrganizationRepo
          ? {
              bypass_pull_request_allowances: {
                users: [],
                teams: [],
                apps: [],
              },
            }
          : {}),
      },
      restrictions: null,
      required_linear_history: false,
      allow_force_pushes: false,
      allow_deletions: false,
      block_creations: false,
      required_conversation_resolution: false,
      lock_branch: false,
      allow_fork_syncing: false,
    });
  const enforceAdmins = options.enforceAdmins ?? base.enforce_admins === true;
  const requireConversationResolution =
    options.requireConversationResolution ?? base.required_conversation_resolution;
  const requireLastPushApproval =
    options.requireLastPushApproval ??
    base.required_pull_request_reviews.require_last_push_approval;
  const requireLinearHistory = options.requireLinearHistory ?? base.required_linear_history;
  const requiredStatusChecks = Array.from(
    new Set(
      (options.requiredStatusChecks ?? base.required_status_checks?.contexts ?? [])
        .map((check) => check.trim())
        .filter(Boolean),
    ),
  );

  return branchProtectionPayloadSchema.parse({
    required_status_checks:
      requiredStatusChecks.length > 0
        ? {
            strict: true,
            contexts: requiredStatusChecks,
          }
        : null,
    enforce_admins: enforceAdmins ? true : null,
    required_pull_request_reviews: {
      ...(isOrganizationRepo
        ? {
            dismissal_restrictions: {
              users: [],
              teams: [],
              apps: [],
            },
          }
        : {}),
      dismiss_stale_reviews: true,
      require_code_owner_reviews: base.required_pull_request_reviews.require_code_owner_reviews,
      required_approving_review_count:
        base.required_pull_request_reviews.required_approving_review_count,
      require_last_push_approval: requireLastPushApproval,
      ...(isOrganizationRepo
        ? {
            bypass_pull_request_allowances: {
              users: [],
              teams: [],
              apps: [],
            },
          }
        : {}),
    },
    restrictions: null,
    required_linear_history: requireLinearHistory,
    allow_force_pushes: base.allow_force_pushes,
    allow_deletions: base.allow_deletions,
    block_creations: base.block_creations,
    required_conversation_resolution: requireConversationResolution,
    lock_branch: base.lock_branch,
    allow_fork_syncing: base.allow_fork_syncing,
  });
}

function approvalContributorCount(
  repo: string,
  runner: CommandRunner = defaultRunner,
): number | null {
  try {
    const raw = runner(["gh", "api", `repos/${repo}/collaborators?per_page=100`]).stdout;
    const parsed = JSON.parse(raw) as Array<{ permissions?: Record<string, unknown> }>;
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed.filter((collaborator) => {
      const permissions = collaborator.permissions ?? {};
      return (
        permissions.admin === true || permissions.maintain === true || permissions.push === true
      );
    }).length;
  } catch {
    return null;
  }
}

function managedRulesetName(branch: string): string {
  return `prx ${branch} branch ruleset`;
}

function desiredProtectionPayload(
  repoPath: string,
  repo: string,
  ownerType: string,
  branch: string,
  options: {
    enforceAdmins?: boolean | undefined;
    requireConversationResolution?: boolean | undefined;
    requireLastPushApproval?: boolean | undefined;
    requireLinearHistory?: boolean | undefined;
    requiredStatusChecks?: string[] | undefined;
    solo?: boolean | undefined;
  },
  runner: CommandRunner,
): {
  contributorCount: number | null;
  requireLastPushApprovalSuppressed: boolean;
  requiredApprovingReviewCountSuppressed: boolean;
  payload: z.infer<typeof branchProtectionPayloadSchema>;
} {
  const spec = loadBranchProtectionSpec(repoPath, branch, runner);
  const contributorCount = approvalContributorCount(repo, runner);
  const basePayload = desiredBranchProtectionPayload(ownerType, options, spec?.protection);
  const payload = options.solo
    ? branchProtectionPayloadSchema.parse({
        ...basePayload,
        required_conversation_resolution: false,
        required_pull_request_reviews: {
          ...basePayload.required_pull_request_reviews,
          dismiss_stale_reviews: false,
          required_approving_review_count: 0,
          require_last_push_approval: false,
        },
      })
    : basePayload;
  const requireLastPushApprovalSuppressed =
    payload.required_pull_request_reviews.require_last_push_approval &&
    contributorCount !== null &&
    contributorCount < 2;
  const requiredApprovingReviewCountSuppressed =
    payload.required_pull_request_reviews.required_approving_review_count > 0 &&
    contributorCount !== null &&
    contributorCount < 2;
  const effectivePayload =
    requireLastPushApprovalSuppressed || requiredApprovingReviewCountSuppressed
      ? branchProtectionPayloadSchema.parse({
          ...payload,
          required_pull_request_reviews: {
            ...payload.required_pull_request_reviews,
            require_last_push_approval: requireLastPushApprovalSuppressed
              ? false
              : payload.required_pull_request_reviews.require_last_push_approval,
            required_approving_review_count: requiredApprovingReviewCountSuppressed
              ? 0
              : payload.required_pull_request_reviews.required_approving_review_count,
          },
        })
      : payload;

  return {
    contributorCount,
    requireLastPushApprovalSuppressed,
    requiredApprovingReviewCountSuppressed,
    payload: effectivePayload,
  };
}

function desiredRepositoryRuleset(
  branch: string,
  payload: z.infer<typeof branchProtectionPayloadSchema>,
): Record<string, unknown> {
  const rules: Array<Record<string, unknown>> = [
    {
      type: "pull_request",
      parameters: {
        dismiss_stale_reviews_on_push: payload.required_pull_request_reviews.dismiss_stale_reviews,
        require_code_owner_review: payload.required_pull_request_reviews.require_code_owner_reviews,
        require_last_push_approval:
          payload.required_pull_request_reviews.require_last_push_approval,
        required_approving_review_count:
          payload.required_pull_request_reviews.required_approving_review_count,
        required_review_thread_resolution: payload.required_conversation_resolution,
      },
    },
    { type: "deletion" },
    { type: "non_fast_forward" },
  ];

  if (payload.required_linear_history) {
    rules.push({ type: "required_linear_history" });
  }

  if (payload.required_status_checks) {
    rules.push({
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: payload.required_status_checks.strict,
        required_status_checks: payload.required_status_checks.contexts.map((context) => ({
          context,
        })),
      },
    });
  }

  return {
    name: managedRulesetName(branch),
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: {
      ref_name: {
        include: [`refs/heads/${branch}`],
        exclude: [],
      },
    },
    rules,
  };
}

function listRepositoryRulesets(
  repo: string,
  runner: CommandRunner = defaultRunner,
): Array<z.infer<typeof repositoryRulesetSummarySchema>> {
  const raw = runner([
    "gh",
    "api",
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    "X-GitHub-Api-Version: 2022-11-28",
    `repos/${repo}/rulesets?per_page=100`,
  ]).stdout;
  return z.array(repositoryRulesetSummarySchema).parse(JSON.parse(raw));
}

function getRepositoryRuleset(
  repo: string,
  id: number,
  runner: CommandRunner = defaultRunner,
): z.infer<typeof repositoryRulesetSchema> {
  const raw = runner([
    "gh",
    "api",
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    "X-GitHub-Api-Version: 2022-11-28",
    `repos/${repo}/rulesets/${id}`,
  ]).stdout;
  return repositoryRulesetSchema.parse(JSON.parse(raw));
}

function findManagedRuleset(
  repo: string,
  branch: string,
  runner: CommandRunner = defaultRunner,
): z.infer<typeof repositoryRulesetSchema> | null {
  const expectedRef = `refs/heads/${branch}`;
  for (const summary of listRepositoryRulesets(repo, runner)) {
    if (summary.target !== "branch" || summary.name !== managedRulesetName(branch)) {
      continue;
    }
    const ruleset = getRepositoryRuleset(repo, summary.id, runner);
    if (ruleset.conditions.ref_name.include.includes(expectedRef)) {
      return ruleset;
    }
  }
  return null;
}

function normalizeLiveRulesetToBranchProtection(
  ruleset: z.infer<typeof repositoryRulesetSchema>,
): z.infer<typeof branchProtectionPayloadSchema> {
  const pullRequestRule = ruleset.rules.find((rule) => rule.type === "pull_request");
  const requiredStatusChecksRule = ruleset.rules.find(
    (rule) => rule.type === "required_status_checks",
  );
  const requiredLinearHistory = ruleset.rules.some(
    (rule) => rule.type === "required_linear_history",
  );
  const blockDeletion = ruleset.rules.some((rule) => rule.type === "deletion");
  const blockForcePushes = ruleset.rules.some((rule) => rule.type === "non_fast_forward");
  const pullRequestParameters = (pullRequestRule?.parameters ?? {}) as Record<string, unknown>;
  const statusCheckParameters = (requiredStatusChecksRule?.parameters ?? {}) as Record<
    string,
    unknown
  >;
  const statusChecks = Array.isArray(statusCheckParameters.required_status_checks)
    ? statusCheckParameters.required_status_checks
    : [];
  const contexts = statusChecks
    .map((statusCheck) =>
      statusCheck &&
      typeof statusCheck === "object" &&
      "context" in statusCheck &&
      typeof statusCheck.context === "string"
        ? statusCheck.context
        : null,
    )
    .filter((context): context is string => Boolean(context));

  return branchProtectionPayloadSchema.parse({
    required_status_checks:
      contexts.length > 0
        ? {
            strict: Boolean(statusCheckParameters.strict_required_status_checks_policy),
            contexts,
          }
        : null,
    enforce_admins: ruleset.bypass_actors.length === 0 ? true : null,
    required_pull_request_reviews: {
      dismiss_stale_reviews: Boolean(pullRequestParameters.dismiss_stale_reviews_on_push),
      require_code_owner_reviews: Boolean(pullRequestParameters.require_code_owner_review),
      required_approving_review_count:
        typeof pullRequestParameters.required_approving_review_count === "number"
          ? pullRequestParameters.required_approving_review_count
          : 0,
      require_last_push_approval: Boolean(pullRequestParameters.require_last_push_approval),
    },
    restrictions: null,
    required_linear_history: requiredLinearHistory,
    allow_force_pushes: !blockForcePushes,
    allow_deletions: !blockDeletion,
    block_creations: false,
    required_conversation_resolution: Boolean(
      pullRequestParameters.required_review_thread_resolution,
    ),
    lock_branch: false,
    allow_fork_syncing: false,
  });
}

function normalizeLiveBranchProtection(
  value: Record<string, unknown>,
  ownerType: string,
): z.infer<typeof branchProtectionPayloadSchema> {
  const isOrganizationRepo = ownerType === "Organization";
  const reviews = (value.required_pull_request_reviews ?? {}) as Record<string, unknown>;
  const statusChecksNode = value.required_status_checks as
    | Record<string, unknown>
    | null
    | undefined;
  const rawContexts = Array.isArray(statusChecksNode?.contexts) ? statusChecksNode?.contexts : [];
  const contexts = rawContexts
    .map((context) => {
      if (typeof context === "string") return context;
      if (
        context &&
        typeof context === "object" &&
        "context" in context &&
        typeof context.context === "string"
      ) {
        return context.context;
      }
      return null;
    })
    .filter((context): context is string => Boolean(context));
  const normalizedStatusChecks =
    contexts.length > 0
      ? {
          strict: Boolean(statusChecksNode?.strict),
          contexts,
        }
      : null;

  return branchProtectionPayloadSchema.parse({
    required_status_checks: normalizedStatusChecks,
    enforce_admins: (value.enforce_admins as { enabled?: boolean } | null | undefined)?.enabled
      ? true
      : null,
    required_pull_request_reviews: {
      ...(isOrganizationRepo
        ? {
            dismissal_restrictions: {
              users: [],
              teams: [],
              apps: [],
            },
          }
        : {}),
      dismiss_stale_reviews: Boolean(reviews.dismiss_stale_reviews),
      require_code_owner_reviews: Boolean(reviews.require_code_owner_reviews),
      required_approving_review_count:
        typeof reviews.required_approving_review_count === "number"
          ? reviews.required_approving_review_count
          : 0,
      require_last_push_approval: Boolean(reviews.require_last_push_approval),
      ...(isOrganizationRepo
        ? {
            bypass_pull_request_allowances: {
              users: [],
              teams: [],
              apps: [],
            },
          }
        : {}),
    },
    restrictions: null,
    required_linear_history: Boolean(
      (value.required_linear_history as { enabled?: boolean } | null | undefined)?.enabled,
    ),
    allow_force_pushes: Boolean(
      (value.allow_force_pushes as { enabled?: boolean } | null | undefined)?.enabled,
    ),
    allow_deletions: Boolean(
      (value.allow_deletions as { enabled?: boolean } | null | undefined)?.enabled,
    ),
    block_creations: Boolean(
      (value.block_creations as { enabled?: boolean } | null | undefined)?.enabled,
    ),
    required_conversation_resolution: Boolean(
      (value.required_conversation_resolution as { enabled?: boolean } | null | undefined)?.enabled,
    ),
    lock_branch: Boolean((value.lock_branch as { enabled?: boolean } | null | undefined)?.enabled),
    allow_fork_syncing: Boolean(
      (value.allow_fork_syncing as { enabled?: boolean } | null | undefined)?.enabled,
    ),
  });
}

function sortedStrings(values: string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function comparableBranchProtection(
  payload: z.infer<typeof branchProtectionPayloadSchema>,
): z.infer<typeof branchProtectionPayloadSchema> {
  return {
    ...payload,
    required_status_checks: payload.required_status_checks
      ? {
          strict: payload.required_status_checks.strict,
          contexts: sortedStrings(payload.required_status_checks.contexts),
        }
      : null,
    required_pull_request_reviews: {
      ...payload.required_pull_request_reviews,
      dismissal_restrictions: payload.required_pull_request_reviews.dismissal_restrictions
        ? {
            users: sortedStrings(
              payload.required_pull_request_reviews.dismissal_restrictions.users,
            ),
            teams: sortedStrings(
              payload.required_pull_request_reviews.dismissal_restrictions.teams,
            ),
            apps: sortedStrings(payload.required_pull_request_reviews.dismissal_restrictions.apps),
          }
        : undefined,
      bypass_pull_request_allowances: payload.required_pull_request_reviews
        .bypass_pull_request_allowances
        ? {
            users: sortedStrings(
              payload.required_pull_request_reviews.bypass_pull_request_allowances.users,
            ),
            teams: sortedStrings(
              payload.required_pull_request_reviews.bypass_pull_request_allowances.teams,
            ),
            apps: sortedStrings(
              payload.required_pull_request_reviews.bypass_pull_request_allowances.apps,
            ),
          }
        : undefined,
    },
  };
}

function branchProtectionMatches(
  desired: z.infer<typeof branchProtectionPayloadSchema>,
  live: z.infer<typeof branchProtectionPayloadSchema>,
): boolean {
  return (
    JSON.stringify(comparableBranchProtection(desired)) ===
    JSON.stringify(comparableBranchProtection(live))
  );
}

export function protectMainBranch(
  repoPath: string,
  options: {
    backend?: ProtectMainBackend | undefined;
    repo?: string | undefined;
    branch?: string | undefined;
    apply?: boolean | undefined;
    solo?: boolean | undefined;
    enforceAdmins?: boolean | undefined;
    requireConversationResolution?: boolean | undefined;
    requireLastPushApproval?: boolean | undefined;
    requireLinearHistory?: boolean | undefined;
    requiredStatusChecks?: string[] | undefined;
  } = {},
  runner: CommandRunner = defaultRunner,
): ProtectMainBranchResult {
  const repo = options.repo ?? repoNameWithOwner(repoPath, runner);
  const viewer = viewerLogin(runner);
  const owner = repo.split("/")[0] ?? "";
  const ownerType = repoOwnerType(repo, runner);
  const branch = options.branch ?? "main";
  const apply = options.apply ?? false;
  const backend = options.backend ?? "branch-protection";

  if (viewer !== owner) {
    throw new Error(
      `protect-main requires repo ownership: viewer=${viewer} owner=${owner} repo=${repo}`,
    );
  }

  const desired = desiredProtectionPayload(
    repoPath,
    repo,
    ownerType,
    branch,
    {
      solo: options.solo,
      enforceAdmins: options.enforceAdmins,
      requireConversationResolution: options.requireConversationResolution,
      requireLastPushApproval: options.requireLastPushApproval,
      requireLinearHistory: options.requireLinearHistory,
      requiredStatusChecks: options.requiredStatusChecks,
    },
    runner,
  );
  const effectivePayload =
    backend === "ruleset"
      ? branchProtectionPayloadSchema.parse({
          ...desired.payload,
          enforce_admins: true,
        })
      : desired.payload;
  let command: string[];
  let rulesetId: number | null = null;
  let rulesetName: string | null = null;

  if (backend === "ruleset") {
    const ruleset = desiredRepositoryRuleset(branch, effectivePayload);
    rulesetName = ruleset.name as string;
    const existingRuleset = findManagedRuleset(repo, branch, runner);
    rulesetId = existingRuleset?.id ?? null;
    command = [
      "gh",
      "api",
      "--method",
      existingRuleset ? "PUT" : "POST",
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "X-GitHub-Api-Version: 2022-11-28",
      existingRuleset ? `repos/${repo}/rulesets/${existingRuleset.id}` : `repos/${repo}/rulesets`,
      "--input",
      "<generated-json>",
    ];

    if (apply) {
      const payloadDir = mkdtempSync(join(tmpDir(), "prx-protect-main-"));
      const payloadPath = join(payloadDir, "ruleset.json");
      try {
        writeFileSync(payloadPath, JSON.stringify(ruleset, null, 2));
        runner(
          [
            "gh",
            "api",
            "--method",
            existingRuleset ? "PUT" : "POST",
            "-H",
            "Accept: application/vnd.github+json",
            "-H",
            "X-GitHub-Api-Version: 2022-11-28",
            existingRuleset
              ? `repos/${repo}/rulesets/${existingRuleset.id}`
              : `repos/${repo}/rulesets`,
            "--input",
            payloadPath,
          ],
          { cwd: repoPath },
        );
      } finally {
        rmSync(payloadDir, { recursive: true, force: true });
      }
    }
  } else {
    command = [
      "gh",
      "api",
      "--method",
      "PUT",
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "X-GitHub-Api-Version: 2022-11-28",
      `repos/${repo}/branches/${branch}/protection`,
      "--input",
      "<generated-json>",
    ];

    if (apply) {
      const payloadDir = mkdtempSync(join(tmpDir(), "prx-protect-main-"));
      const payloadPath = join(payloadDir, "branch-protection.json");
      try {
        writeFileSync(payloadPath, JSON.stringify(desired.payload, null, 2));
        runner(
          [
            "gh",
            "api",
            "--method",
            "PUT",
            "-H",
            "Accept: application/vnd.github+json",
            "-H",
            "X-GitHub-Api-Version: 2022-11-28",
            `repos/${repo}/branches/${branch}/protection`,
            "--input",
            payloadPath,
          ],
          { cwd: repoPath },
        );
      } finally {
        rmSync(payloadDir, { recursive: true, force: true });
      }
    }
  }

  return {
    backend,
    repo,
    branch,
    viewer,
    owner,
    ownerType,
    rulesetId,
    rulesetName,
    solo: options.solo ?? false,
    approvalContributorCount: desired.contributorCount,
    requireLastPushApprovalSuppressed: desired.requireLastPushApprovalSuppressed,
    requiredApprovingReviewCountSuppressed: desired.requiredApprovingReviewCountSuppressed,
    apply,
    applied: apply,
    enforceAdmins: effectivePayload.enforce_admins === true,
    requireConversationResolution: effectivePayload.required_conversation_resolution,
    requireLastPushApproval:
      effectivePayload.required_pull_request_reviews.require_last_push_approval,
    requiredApprovingReviewCount:
      effectivePayload.required_pull_request_reviews.required_approving_review_count,
    requireLinearHistory: effectivePayload.required_linear_history,
    requiredStatusChecks: effectivePayload.required_status_checks?.contexts ?? [],
    payload: effectivePayload,
    command,
  };
}

export function checkMainBranchProtection(
  repoPath: string,
  options: {
    backend?: ProtectMainBackend | undefined;
    repo?: string | undefined;
    branch?: string | undefined;
    solo?: boolean | undefined;
    enforceAdmins?: boolean | undefined;
    requireConversationResolution?: boolean | undefined;
    requireLastPushApproval?: boolean | undefined;
    requireLinearHistory?: boolean | undefined;
    requiredStatusChecks?: string[] | undefined;
  } = {},
  runner: CommandRunner = defaultRunner,
): ProtectMainBranchCheckResult {
  const repo = options.repo ?? repoNameWithOwner(repoPath, runner);
  const viewer = viewerLogin(runner);
  const owner = repo.split("/")[0] ?? "";
  const ownerType = repoOwnerType(repo, runner);
  const branch = options.branch ?? "main";
  const backend = options.backend ?? "branch-protection";
  const desired = desiredProtectionPayload(repoPath, repo, ownerType, branch, options, runner);
  const effectiveDesired =
    backend === "ruleset"
      ? branchProtectionPayloadSchema.parse({
          ...desired.payload,
          enforce_admins: true,
        })
      : desired.payload;
  let live: z.infer<typeof branchProtectionPayloadSchema>;
  let rulesetId: number | null = null;
  let rulesetName: string | null = null;

  if (backend === "ruleset") {
    const existingRuleset = findManagedRuleset(repo, branch, runner);
    rulesetId = existingRuleset?.id ?? null;
    rulesetName = existingRuleset?.name ?? managedRulesetName(branch);
    live = existingRuleset
      ? normalizeLiveRulesetToBranchProtection(existingRuleset)
      : branchProtectionPayloadSchema.parse({
          required_status_checks: null,
          enforce_admins: null,
          required_pull_request_reviews: {
            dismiss_stale_reviews: false,
            require_code_owner_reviews: false,
            required_approving_review_count: 0,
            require_last_push_approval: false,
          },
          restrictions: null,
          required_linear_history: false,
          allow_force_pushes: true,
          allow_deletions: true,
          block_creations: false,
          required_conversation_resolution: false,
          lock_branch: false,
          allow_fork_syncing: false,
        });
  } else {
    const liveRaw = JSON.parse(
      runner(["gh", "api", `repos/${repo}/branches/${branch}/protection`], { cwd: repoPath })
        .stdout,
    ) as Record<string, unknown>;
    live = normalizeLiveBranchProtection(liveRaw, ownerType);
  }

  return {
    backend,
    repo,
    branch,
    viewer,
    owner,
    ownerType,
    rulesetId,
    rulesetName,
    solo: options.solo ?? false,
    approvalContributorCount: desired.contributorCount,
    requireLastPushApprovalSuppressed: desired.requireLastPushApprovalSuppressed,
    requiredApprovingReviewCountSuppressed: desired.requiredApprovingReviewCountSuppressed,
    enforceAdmins: effectiveDesired.enforce_admins === true,
    requireConversationResolution: effectiveDesired.required_conversation_resolution,
    requireLastPushApproval:
      effectiveDesired.required_pull_request_reviews.require_last_push_approval,
    requiredApprovingReviewCount:
      effectiveDesired.required_pull_request_reviews.required_approving_review_count,
    requireLinearHistory: effectiveDesired.required_linear_history,
    requiredStatusChecks: effectiveDesired.required_status_checks?.contexts ?? [],
    desired: effectiveDesired,
    live,
    matches: branchProtectionMatches(effectiveDesired, live),
  };
}

/**
 * GH-1346: live branch-protection projection consumed by `prx doctor merge`.
 *
 * Doctor's I04 review-decision gate must mirror what GitHub itself enforces.
 * On solo repos with `required_approving_review_count: 0` the doctor would
 * otherwise deadlock waiting for an APPROVED review that branch protection
 * never asks for. Returning `null` distinguishes "no protection rule on this
 * branch" (also implies no enforced review gate) from "rule exists but
 * required_approving_review_count is 0".
 */
export type LiveBranchProtection = {
  requiredApprovingReviewCount: number;
  requireCodeOwnerReviews: boolean;
};

export function fetchBranchProtection(
  repoPath: string,
  branch: string,
  runner: CommandRunner = defaultRunner,
): LiveBranchProtection | null {
  const repo = repoNameWithOwner(repoPath, runner);
  const result = runner(["gh", "api", `repos/${repo}/branches/${branch}/protection`], {
    cwd: repoPath,
    check: false,
  });
  if (result.status !== 0) {
    if (/HTTP 404/i.test(result.stderr) || /Branch not protected/i.test(result.stderr)) {
      return null;
    }
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        `gh api branch protection failed (status=${result.status})`,
    );
  }
  const ownerType = repoOwnerType(repo, runner);
  const live = normalizeLiveBranchProtection(
    JSON.parse(result.stdout) as Record<string, unknown>,
    ownerType,
  );
  return {
    requiredApprovingReviewCount:
      live.required_pull_request_reviews.required_approving_review_count,
    requireCodeOwnerReviews: live.required_pull_request_reviews.require_code_owner_reviews,
  };
}

export function repoCheckNames(
  repoPath: string,
  options: {
    repo?: string | undefined;
    branch?: string | undefined;
  } = {},
  runner: CommandRunner = defaultRunner,
): RepoCheckNamesResult {
  const repo = options.repo ?? repoNameWithOwner(repoPath, runner);
  const branch = options.branch ?? "main";
  const sha = runner(["gh", "api", `repos/${repo}/branches/${branch}`, "--jq", ".commit.sha"], {
    cwd: repoPath,
  }).stdout.trim();
  const result = runner(
    ["gh", "api", `repos/${repo}/commits/${sha}/check-runs`, "--jq", ".check_runs[].name"],
    { cwd: repoPath },
  );
  const checks = Array.from(
    new Set(
      result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ).sort((a, b) => a.localeCompare(b));

  return {
    repo,
    branch,
    sha,
    checks,
  };
}

export function listOpenPrs(repo: string, runner: CommandRunner = defaultRunner): OpenPr[] {
  const result = runner([
    "gh",
    "pr",
    "list",
    "--author",
    "@me",
    "--state",
    "open",
    "--json",
    "number,headRefName,title,isDraft,url,reviewDecision,statusCheckRollup,mergeable,reviews",
    "-R",
    repo,
  ]);

  return JSON.parse(result.stdout) as OpenPr[];
}

export function listRepoOpenPrs(repo: string, runner: CommandRunner = defaultRunner): OpenPr[] {
  const result = runner([
    "gh",
    "pr",
    "list",
    "--state",
    "open",
    "--json",
    "number,headRefName,title,isDraft,url,reviewDecision,statusCheckRollup,mergeable,reviews",
    "-R",
    repo,
  ]);

  return JSON.parse(result.stdout) as OpenPr[];
}

export function listOpenIssues(
  repo: string,
  limit = 5,
  runner: CommandRunner = defaultRunner,
): FallbackIssue[] {
  const result = runner(
    [
      "gh",
      "issue",
      "list",
      "--state",
      "open",
      "--limit",
      String(limit),
      "--json",
      "number,title,url,labels",
      "-R",
      repo,
    ],
    { check: false },
  );
  if (result.status !== 0) return [];
  try {
    return JSON.parse(result.stdout) as FallbackIssue[];
  } catch {
    return [];
  }
}

export type GitHubIssueState = "open" | "closed" | "all";

// Sibling to `listOpenIssues` parameterized by `--state`. Callers (e.g.
// `prx beads publish` reverse-orphan dedup) pass `state: "all"` to match
// against closed GH issues, not just open ones.
export function listIssuesByState(
  repo: string,
  state: GitHubIssueState,
  limit = 1000,
  runner: CommandRunner = defaultRunner,
): FallbackIssue[] {
  const result = runner(
    [
      "gh",
      "issue",
      "list",
      "--state",
      state,
      "--limit",
      String(limit),
      "--json",
      "number,title,url,labels",
      "-R",
      repo,
    ],
    { check: false },
  );
  if (result.status !== 0) return [];
  try {
    return JSON.parse(result.stdout) as FallbackIssue[];
  } catch {
    return [];
  }
}

export type GitHubIssueLabel = { name: string };

export type GitHubIssue = {
  number: number;
  title: string;
  state: string;
  body?: string;
  url?: string;
  labels?: GitHubIssueLabel[];
};

export function validateGitHubIssue(
  repo: string,
  issueNumber: number,
  runner: CommandRunner = defaultRunner,
): GitHubIssue {
  const result = runner(
    [
      "gh",
      "issue",
      "view",
      String(issueNumber),
      "--json",
      "number,title,state,body,url,labels",
      "-R",
      repo,
    ],
    { check: false },
  );
  if (result.status !== 0) {
    const msg = result.stderr?.trim() || result.stdout?.trim() || `issue ${issueNumber} not found`;
    throw new Error(`GitHub issue #${issueNumber} not found in ${repo}: ${msg}`);
  }
  try {
    return JSON.parse(result.stdout) as GitHubIssue;
  } catch {
    throw new Error(`Failed to parse issue response for #${issueNumber} in ${repo}`);
  }
}

export function validateBeadsIssue(
  repoPath: string,
  beadId: string,
  runner: CommandRunner = defaultRunner,
): BeadsIssueView {
  hydrateBeads(repoPath, beadId, runner);
  const issue = maybeViewBeadsIssue(repoPath, beadId);
  if (!issue) {
    throw new Error(`Beads issue ${beadId} not found in ${repoPath}`);
  }
  return issue;
}

export function worktreeMap(
  repoPath: string,
  runner: CommandRunner = defaultRunner,
): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const entry of listWorktrees(repoPath, runner)) {
    if (entry.branch) {
      mapping[entry.branch] = entry.path;
    }
  }
  return mapping;
}

export function listWorktrees(
  repoPath: string,
  runner: CommandRunner = defaultRunner,
): ListedWorktree[] {
  const result = runner(["git", "-C", repoPath, "worktree", "list", "--porcelain"]);
  const entries: ListedWorktree[] = [];
  let currentPath: string | undefined;
  let currentBranch: string | null = null;
  let currentHead: string | null = null;
  let currentDetached = false;
  let currentLocked = false;
  let currentLockReason: string | null = null;

  const pushCurrent = () => {
    if (!currentPath) return;
    entries.push({
      path: currentPath,
      branch: currentBranch,
      head: currentHead,
      detached: currentDetached,
      locked: currentLocked,
      lockReason: currentLockReason,
    });
    currentPath = undefined;
    currentBranch = null;
    currentHead = null;
    currentDetached = false;
    currentLocked = false;
    currentLockReason = null;
  };

  for (const rawLine of result.stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      pushCurrent();
      continue;
    }

    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
      continue;
    }

    if (line.startsWith("HEAD ")) {
      currentHead = line.slice("HEAD ".length).trim() || null;
      continue;
    }

    if (line === "detached") {
      currentDetached = true;
      continue;
    }

    if (line.startsWith("branch refs/heads/")) {
      currentBranch = line.slice("branch refs/heads/".length);
      continue;
    }

    if (line.startsWith("locked")) {
      currentLocked = true;
      const reason = line.slice("locked".length).trim();
      currentLockReason = reason.length > 0 ? reason : null;
    }
  }

  pushCurrent();
  return entries;
}

export function lockWorktree(
  worktreePath: string,
  reason: string,
  runner: CommandRunner = defaultRunner,
): void {
  runner(["git", "-C", worktreePath, "worktree", "lock", "--reason", reason, "."]);
}

export function unlockWorktree(worktreePath: string, runner: CommandRunner = defaultRunner): void {
  runner(["git", "-C", worktreePath, "worktree", "unlock", "."]);
}

export function removeWorktree(
  repoPath: string,
  target: string,
  options: {
    force?: boolean;
    prune?: boolean;
    deleteBranch?: boolean;
    dryRun?: boolean;
    isPidAlive?: PidAliveProbe;
  } = {},
  runner: CommandRunner = defaultRunner,
): WorktreeRemoveResult {
  const worktrees = listWorktrees(repoPath, runner);
  const directEntry = worktrees.find((entry) => entry.branch === target) ?? null;
  const entryByPath = worktrees.find((entry) => entry.path === target) ?? null;
  const resolvedTarget = resolve(repoPath, target);
  const entryByResolvedPath =
    worktrees.find((entry) => resolve(repoPath, entry.path) === resolvedTarget) ?? null;
  // GH-756: orphan-cleanup callers (today: the `orphan_cleanup` thread of
  // `prx next` / `prx delegate next`) emit `GH-<n>` tokens as the
  // suggested-command target (e.g. `prx worktree-remove GH-674
  // --delete-branch`), but a detached-HEAD worktree for that ticket has
  // `branch: null` and a directory name like `gh_<n>_<slug>`, so
  // branch/path/resolved-path lookups all miss. Accept the canonical
  // ticket form by matching the on-disk basename prefix.
  const ticketMatch = target.match(/^GH-(\d+)$/i);
  const entryByTicket = ticketMatch
    ? (worktrees.find((entry) => basename(entry.path).startsWith(`gh_${ticketMatch[1]}_`)) ?? null)
    : null;
  const matchedEntry = directEntry ?? entryByPath ?? entryByResolvedPath ?? entryByTicket;

  const path = matchedEntry?.path ?? target;
  const normalizedPath = resolve(repoPath, path);
  const branch = directEntry?.branch ?? matchedEntry?.branch ?? null;
  const force = options.force ?? false;
  const prune = options.prune ?? true;
  const deleteBranch = options.deleteBranch ?? false;
  const dryRun = options.dryRun ?? false;
  const isPidAlive = options.isPidAlive ?? defaultPidAliveProbe;

  if (!matchedEntry && !existsSync(normalizedPath)) {
    throw new Error(`No worktree found for '${target}'`);
  }

  if (matchedEntry?.locked) {
    const pid = parseSessionLockPid(matchedEntry.lockReason);
    const stale = pid !== null && !isPidAlive(pid);
    if (force && stale && !dryRun) {
      runner(["git", "-C", repoPath, "worktree", "unlock", matchedEntry.path]);
    } else if (!force || !stale) {
      const reason = matchedEntry.lockReason ? `: ${matchedEntry.lockReason}` : "";
      throw new Error(
        `Worktree '${matchedEntry.path}' is locked${reason}. Unlock it after the active session ends with: git -C ${shellQuote(repoPath)} worktree unlock ${shellQuote(matchedEntry.path)}`,
      );
    }
  }

  // Refuse to remove a worktree with uncommitted changes unless --force is set.
  // Discovered via GH-757: the orphan-cleanup thread of `prx next` (and
  // now `prx delegate next`) can suggest removal (incorrectly; see
  // GH-755) and `--delete-branch` would then discard unresolved merge
  // conflicts or in-flight edits. --force is the documented escape hatch.
  if (matchedEntry && !force) {
    const statusResult = runner(["git", "-C", matchedEntry.path, "status", "--porcelain=v1"]);
    if (statusResult.status === 0 && statusResult.stdout.trim().length > 0) {
      throw new Error(
        `Worktree '${matchedEntry.path}' has uncommitted changes. Commit or stash them, or pass --force to discard.`,
      );
    }
  }

  if (!dryRun) {
    const removeArgs = ["git", "-C", repoPath, "worktree", "remove"];
    if (force) {
      removeArgs.push("--force");
    }
    removeArgs.push(path);
    runner(removeArgs);

    if (prune) {
      runner(["git", "-C", repoPath, "worktree", "prune"]);
    }

    if (existsSync(normalizedPath)) {
      throw new Error(`Worktree path still exists after removal: ${normalizedPath}`);
    }

    if (deleteBranch && branch) {
      const protectedBranches = new Set(["main", "master", "trunk"]);
      const allowProtectedDelete = getEnv("PRX_ALLOW_DELETE_PROTECTED_BRANCH") === "1";
      if (protectedBranches.has(branch) && !allowProtectedDelete) {
        throw new Error(
          `Refusing to delete protected branch '${branch}'. Set PRX_ALLOW_DELETE_PROTECTED_BRANCH=1 to override this safeguard.`,
        );
      }
      runner(["git", "-C", repoPath, "branch", "-D", branch]);
    }
  }

  const displayPath = (() => {
    const relativePath = relative(repoPath, normalizedPath);
    if (!relativePath || relativePath.length === 0) {
      return ".";
    }
    return relativePath;
  })();

  return {
    repoPath,
    target,
    path: displayPath,
    resolvedPath: normalizedPath,
    branch,
    force,
    prune,
    deleteBranch,
    dryRun,
    removed: !dryRun,
    branchDeleted: !dryRun && deleteBranch && Boolean(branch),
  };
}

export function loadContractForBranch(worktreePath: string): {
  contract: Contract | null;
  contractPath: string;
} {
  const contractPath = join(worktreePath, ".pr", "local", "pr.json");
  if (!existsSync(contractPath)) {
    return { contract: null, contractPath };
  }

  JSON.parse(readFileSync(contractPath, "utf8")) as Contract;
  return { contract: loadContract(contractPath), contractPath };
}

export function currentModeForPr(pr: OpenPr): StateMode {
  return pr.isDraft ? "draft" : "ready";
}

export type PrView = {
  number: number;
  state?: string | null;
  isDraft: boolean;
  title?: string;
  url?: string;
  headRefName?: string;
  reviewDecision?: string | null;
  statusCheckRollup?:
    | Array<{ status?: string | null; conclusion?: string | null }>
    | {
        state?: string | null;
        contexts?: Array<{ status?: string | null; conclusion?: string | null }> | null;
      }
    | null;
  mergeable?: string | null;
  reviews?:
    | Array<{ state?: string | null }>
    | { nodes?: Array<{ state?: string | null }> | null }
    | null;
};

export type GithubCheckRow = {
  name: string;
  state: string;
  link?: string | null;
  description?: string | null;
};

export type CodeBuildFailedTestCase = {
  name: string | null;
  suite: string | null;
  status: string | null;
  message: string | null;
  details: string | null;
  duration_ns: number | null;
};

export type CodeBuildFailureReport = {
  buildId: string;
  reportArn: string | null;
  failures: CodeBuildFailedTestCase[];
  error: string | null;
};

export type RemoteCiCheckFailure = {
  name: string;
  state: string;
  description: string | null;
  link: string | null;
  codebuild: CodeBuildFailureReport | null;
};

export type RemoteCiCheckResult = {
  repoPath: string;
  pr: string;
  failingChecks: RemoteCiCheckFailure[];
};

const failedCheckStates = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
]);

export function parseCodeBuildIdFromLink(link: string): string | null {
  const direct = link.match(/\/builds\/([^/]+)\/view\/new/i);
  if (direct?.[1]) {
    return decodeURIComponent(direct[1]);
  }

  const hashPath = link.match(/#\/builds\/([^/]+)\/view\/new/i);
  if (hashPath?.[1]) {
    return decodeURIComponent(hashPath[1]);
  }

  return null;
}

function isFailingCheckState(state: string): boolean {
  return failedCheckStates.has((state ?? "").toUpperCase());
}

export function listFailingPrChecks(
  repoPath: string,
  prRef: string,
  runner: CommandRunner = defaultRunner,
): GithubCheckRow[] {
  const result = runner(["gh", "pr", "checks", prRef, "--json", "name,state,link,description"], {
    cwd: repoPath,
  });
  const checks = JSON.parse(result.stdout) as GithubCheckRow[];
  return checks.filter((check) => isFailingCheckState(check.state));
}

export function codeBuildFailuresForBuildId(
  buildId: string,
  runner: CommandRunner = defaultRunner,
): CodeBuildFailureReport {
  const reportLookup = runner(
    [
      "aws",
      "codebuild",
      "batch-get-builds",
      "--ids",
      buildId,
      "--query",
      "builds[0].reportArns[0]",
      "--output",
      "text",
    ],
    { check: false },
  );

  if (reportLookup.status !== 0) {
    const message =
      reportLookup.stderr.trim() || reportLookup.stdout.trim() || "failed to fetch report ARN";
    return { buildId, reportArn: null, failures: [], error: message };
  }

  const reportArn = reportLookup.stdout.trim();
  if (!reportArn || reportArn === "None") {
    return {
      buildId,
      reportArn: null,
      failures: [],
      error: `no report ARN found for build: ${buildId}`,
    };
  }

  const casesLookup = runner(
    [
      "aws",
      "codebuild",
      "describe-test-cases",
      "--report-arn",
      reportArn,
      "--query",
      "testCases[?status==`FAILED`].{name:name,suite:testSuiteName,status:status,message:message,details:statusDetails,duration_ns:durationInNanoSeconds}",
      "--output",
      "json",
    ],
    { check: false },
  );

  if (casesLookup.status !== 0) {
    const message =
      casesLookup.stderr.trim() || casesLookup.stdout.trim() || "failed to fetch test cases";
    return { buildId, reportArn, failures: [], error: message };
  }

  return {
    buildId,
    reportArn,
    failures: JSON.parse(casesLookup.stdout) as CodeBuildFailedTestCase[],
    error: null,
  };
}

export function remoteCiCheck(
  repoPath: string,
  prRef: string,
  runner: CommandRunner = defaultRunner,
): RemoteCiCheckResult {
  const failingChecks = listFailingPrChecks(repoPath, prRef, runner).map((check) => {
    const link = check.link ?? null;
    const buildId = link ? parseCodeBuildIdFromLink(link) : null;
    const isCodeBuild =
      Boolean(buildId) || /codebuild/i.test(check.name ?? "") || /codebuild/i.test(link ?? "");
    const codebuild = isCodeBuild && buildId ? codeBuildFailuresForBuildId(buildId, runner) : null;

    return {
      name: check.name,
      state: check.state,
      description: check.description ?? null,
      link,
      codebuild,
    } as RemoteCiCheckFailure;
  });

  return {
    repoPath,
    pr: prRef,
    failingChecks,
  };
}

export function parseActionsRunIdFromLink(link: string): string | null {
  // GitHub Actions URLs: https://github.com/<owner>/<repo>/actions/runs/<run-id>
  // Also handles job URLs: .../actions/runs/<run-id>/job/<job-id>
  const match = link.match(/\/actions\/runs\/(\d+)/);
  return match?.[1] ?? null;
}

export type ScoutLogsCheckResult = {
  name: string;
  state: string;
  link: string | null;
  runId: string | null;
  logs: string | null;
  error: string | null;
};

export type ScoutLogsResult = {
  repoPath: string;
  pr: string;
  checks: ScoutLogsCheckResult[];
};

export function scoutLogs(
  repoPath: string,
  prRef: string,
  runner: CommandRunner = defaultRunner,
  maxLines: number = 200,
): ScoutLogsResult {
  const failingChecks = listFailingPrChecks(repoPath, prRef, runner);

  const checks: ScoutLogsCheckResult[] = failingChecks.map((check) => {
    const link = check.link ?? null;
    const runId = link ? parseActionsRunIdFromLink(link) : null;

    if (!runId) {
      return {
        name: check.name,
        state: check.state,
        link,
        runId: null,
        logs: null,
        error: link ? "Not a GitHub Actions run — external check" : "No link available",
      };
    }

    try {
      const result = runner(["gh", "run", "view", runId, "--log-failed"], { cwd: repoPath });
      const fullLog = result.stdout;
      // Truncate to last N lines if too long
      const lines = fullLog.split("\n");
      const logs =
        lines.length > maxLines
          ? `... (truncated, showing last ${maxLines} of ${lines.length} lines)\n${lines.slice(-maxLines).join("\n")}`
          : fullLog;

      return { name: check.name, state: check.state, link, runId, logs, error: null };
    } catch (e) {
      return {
        name: check.name,
        state: check.state,
        link,
        runId,
        logs: null,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  });

  return { repoPath, pr: prRef, checks };
}

export function viewPr(
  repoPath: string,
  prRef?: string,
  runner: CommandRunner = defaultRunner,
): PrView {
  const command = ["gh", "pr", "view"];
  if (prRef) {
    command.push(prRef);
  }
  command.push(
    "--json",
    "number,state,isDraft,title,url,headRefName,reviewDecision,statusCheckRollup,mergeable,reviews",
  );
  return JSON.parse(runner(command, { cwd: repoPath }).stdout) as PrView;
}

export function maybeViewCurrentPr(
  repoPath: string,
  runner: CommandRunner = defaultRunner,
): PrView | null {
  const result = runner(
    [
      "gh",
      "pr",
      "view",
      "--json",
      "number,state,isDraft,title,url,headRefName,reviewDecision,statusCheckRollup,mergeable,reviews",
    ],
    { cwd: repoPath, check: false },
  );
  if (result.status !== 0) {
    return null;
  }
  return JSON.parse(result.stdout) as PrView;
}

export type OverviewRow = {
  number: number;
  title: string;
  branch: string;
  url: string;
  draft: boolean;
  checks: "green" | "pending" | "red" | "unknown";
  review: "approved" | "changes_requested" | "review_required" | "commented" | "unknown";
  approvals: number;
  mergeable: "mergeable" | "conflicting" | "unknown";
  worktree: {
    clean: boolean;
    staged: number;
    unstaged: number;
    untracked: number;
    conflicts: number;
  } | null;
  diff?: {
    files: number;
    additions: number;
    deletions: number;
  } | null;
  local?: {
    worktreePath: string;
    contractPath: string;
    lifecycle: string;
    mode: StateMode;
  } | null;
};

export type OverviewResult = {
  repo: string;
  currentBranch: OverviewRow | null;
  createdByYou: OverviewRow[];
};

export const gitStatusCodeLegend = {
  " ": "unmodified",
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  U: "unmerged",
  "?": "untracked",
  "!": "ignored",
} as const;

export type WorktreeSync =
  | "up_to_date"
  | "ahead"
  | "behind"
  | "diverged"
  | "no_upstream"
  | "unknown";

export type WorktreeStatus = {
  branch: {
    name: string | null;
    detached: boolean;
    noCommits: boolean;
    upstream: string | null;
    ahead: number;
    behind: number;
    diverged: boolean;
    sync: WorktreeSync;
  };
  files: {
    staged: string[];
    unstaged: string[];
    untracked: string[];
    ignored: string[];
    conflicts: string[];
  };
  counts: {
    staged: number;
    unstaged: number;
    untracked: number;
    ignored: number;
    conflicts: number;
  };
  clean: boolean;
  codes: typeof gitStatusCodeLegend;
};

function summarizeSync(upstream: string | null, ahead: number, behind: number): WorktreeSync {
  if (!upstream) {
    return "no_upstream";
  }
  if (ahead > 0 && behind > 0) {
    return "diverged";
  }
  if (ahead > 0) {
    return "ahead";
  }
  if (behind > 0) {
    return "behind";
  }
  return "up_to_date";
}

function parseBranchHeader(line: string): WorktreeStatus["branch"] {
  const fallback: WorktreeStatus["branch"] = {
    name: null,
    detached: false,
    noCommits: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    diverged: false,
    sync: "unknown",
  };

  if (!line.startsWith("## ")) {
    return fallback;
  }

  const header = line.slice(3).trim();

  if (header.startsWith("HEAD ")) {
    return {
      ...fallback,
      detached: true,
    };
  }

  if (header.startsWith("No commits yet on ")) {
    const name = header.slice("No commits yet on ".length).trim() || null;
    return {
      ...fallback,
      name,
      noCommits: true,
      sync: "no_upstream",
    };
  }

  const headerParts = header.split(" [", 2);
  const headPart = headerParts[0] ?? "";
  const statusPart = headerParts[1];
  let name: string | null = null;
  let upstream: string | null = null;

  if (headPart.includes("...")) {
    const [local, remote] = headPart.split("...", 2);
    name = local || null;
    upstream = remote || null;
  } else {
    name = headPart || null;
  }

  let ahead = 0;
  let behind = 0;

  if (statusPart) {
    const cleaned = statusPart.replace(/\]$/, "");
    const aheadMatch = cleaned.match(/ahead (\d+)/);
    const behindMatch = cleaned.match(/behind (\d+)/);
    ahead = aheadMatch ? Number.parseInt(aheadMatch[1] ?? "0", 10) : 0;
    behind = behindMatch ? Number.parseInt(behindMatch[1] ?? "0", 10) : 0;
  }

  const sync = summarizeSync(upstream, ahead, behind);

  return {
    ...fallback,
    name,
    upstream,
    ahead,
    behind,
    diverged: sync === "diverged",
    sync,
  };
}

function isConflictCode(x: string, y: string): boolean {
  const pair = `${x}${y}`;
  if (x === "U" || y === "U") {
    return true;
  }
  return (
    pair === "AA" ||
    pair === "DD" ||
    pair === "AU" ||
    pair === "UA" ||
    pair === "DU" ||
    pair === "UD"
  );
}

export function parseWorktreeStatus(porcelain: string): WorktreeStatus {
  const lines = porcelain.split(/\r?\n/).filter(Boolean);
  const branch = parseBranchHeader(lines[0] ?? "");
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  const ignored: string[] = [];
  const conflicts: string[] = [];

  for (const line of lines.slice(1)) {
    if (line.startsWith("?? ")) {
      untracked.push(line.slice(3));
      continue;
    }

    if (line.startsWith("!! ")) {
      ignored.push(line.slice(3));
      continue;
    }

    const x = line[0] ?? " ";
    const y = line[1] ?? " ";
    const path = line.slice(3);
    const conflict = isConflictCode(x, y);

    if (conflict) {
      conflicts.push(path);
      continue;
    }

    if (x !== " ") {
      staged.push(path);
    }

    if (y !== " ") {
      unstaged.push(path);
    }
  }

  const counts = {
    staged: staged.length,
    unstaged: unstaged.length,
    untracked: untracked.length,
    ignored: ignored.length,
    conflicts: conflicts.length,
  };

  return {
    branch,
    files: {
      staged,
      unstaged,
      untracked,
      ignored,
      conflicts,
    },
    counts,
    clean:
      counts.staged === 0 &&
      counts.unstaged === 0 &&
      counts.untracked === 0 &&
      counts.conflicts === 0,
    codes: gitStatusCodeLegend,
  };
}

export function worktreeStatus(
  repoPath: string,
  runner: CommandRunner = defaultRunner,
): WorktreeStatus {
  const result = runner(["git", "-C", repoPath, "status", "--porcelain=v1", "-b"]);
  return parseWorktreeStatus(result.stdout);
}

export const wtSymbolLegend = {
  "!": "modified",
  "?": "untracked",
  "↑": "ahead",
  "↓": "behind",
  "↕": "diverged",
  "✗": "would_conflict",
  "⊂": "integrated",
  "⚑": "branch_worktree_mismatch",
  "–": "same_commit",
  "|": "has_upstream",
} as const;

export type WtState = {
  branch: string | null;
  path: string;
  main_state: string;
  commit?: {
    sha?: string;
    message?: string;
  };
  working_tree?: {
    staged?: boolean;
    modified?: boolean;
    untracked?: boolean;
    deleted?: boolean;
    renamed?: boolean;
  };
  worktree?: {
    detached?: boolean;
    state?: string[] | string | null;
  };
  remote?: {
    ahead?: number;
    behind?: number;
  };
  symbols?: string[] | string | null;
};

export type NormalizedWtState = {
  branch: string;
  path: string;
  integration: string;
  clean: boolean;
  dirty_flags: string[];
  sync: {
    ahead: number;
    behind: number;
    state: WorktreeSync;
  };
  structural: {
    detached: boolean;
    mismatch: boolean;
    states: string[];
  };
  symbols: string[];
  symbol_meanings: string[];
  git?: WorktreeStatus | null;
  commit?: {
    sha: string | null;
    message: string | null;
  };
};

export type WtStatusResult = {
  source: "wt+git";
  wt_available: boolean;
  symbols: typeof wtSymbolLegend;
  worktrees: NormalizedWtState[];
};

export type RemoteFreshness = "fresh" | "stale" | "unknown";

export type RemoteStatus = {
  freshness: RemoteFreshness;
  fetch_required: boolean;
  fetch_status: "ok" | "no-op" | "error";
  updated_refs: string[];
  new_refs: string[];
  deleted_refs: string[];
  raw: string[];
};

export type RepoStatusResult = {
  source: "wt+git+gh";
  repo_root: string;
  operation: "none" | "merge" | "rebase" | "cherry-pick";
  local: WorktreeStatus;
  worktrees: WtStatusResult;
  remote: RemoteStatus;
  pr: {
    exists: boolean;
    number: number | null;
    title: string | null;
    url: string | null;
    draft: boolean | null;
    checks: OverviewRow["checks"] | null;
    review: OverviewRow["review"] | null;
    approvals: number | null;
    mergeable: OverviewRow["mergeable"] | null;
  };
};

export type BoardColumn =
  | "no_worktree"
  | "worktree_created"
  | "branch_created"
  | "committing"
  | "pushed"
  | "pr_open"
  | "ci_running"
  | "review"
  | "changes_requested"
  | "approved"
  | "merge_ready"
  | "cleanup_pending"
  | "merged"
  | "cleaned";

export type BoardUnit = {
  ticket: string | null;
  beadId?: string | null;
  branch: string;
  worktree_path: string | null;
  pr: {
    exists: boolean;
    number: number | null;
    title: string | null;
    url: string | null;
    draft: boolean | null;
    checks: OverviewRow["checks"] | null;
    review: OverviewRow["review"] | null;
    approvals: number | null;
    mergeable: OverviewRow["mergeable"] | null;
  };
  artifacts: {
    worktree: boolean;
    branch: boolean;
    pr: boolean;
    ticket: boolean;
  };
  local: {
    clean: boolean | null;
    staged: number | null;
    unstaged: number | null;
    untracked: number | null;
    conflicts: number | null;
  };
  status?:
    | {
        remote: {
          gh_issue: string;
          beads_issue: string;
          project_item: string;
          branch: string;
          buffer_branch?: string | undefined;
          pr: string;
          merge_state: string;
          ci: string;
          problem: string;
        };
        local: {
          branch: string;
          worktree: string;
          dir: string;
          problem: string;
        };
      }
    | undefined;
  /**
   * GH-914: HEAD authorship of `origin/<branch>`, populated on any unit
   * whose branch exists on origin regardless of which pass produced it.
   * Used by the action enumerator to gate destructive remote ops:
   * `isOperator === false` (positive identification of a different
   * author) suppresses `delete_remote_branch`. `isOperator === null`
   * means operator identity could not be resolved and the gate fails
   * open. Field is absent on units built from a status read that didn't
   * fetch remote authorship, or when no remote branch entry exists for
   * the unit.
   */
  remote_branch_author?:
    | {
        name: string;
        email: string;
        isOperator: boolean | null;
      }
    | undefined;
  column: BoardColumn;
  reasons: string[];
};

export type BoardStatusResult = {
  source: "derived-board";
  repo: string;
  remote_freshness: RemoteFreshness;
  units: BoardUnit[];
};

export type BoardStatusOptions = {
  remote?: boolean;
  // GH-2306: single-unit fast path. When set (and `remote` is true), hydrate
  // remote/local status only for the unit whose branch normalizes to this
  // canonical id; every other unit keeps `status: undefined`. This collapses
  // the per-worktree remote fan-out (4 subprocesses × N worktrees) down to a
  // single unit when a caller already knows the concrete target. Absent on
  // full-board callers, which keep the unscoped path.
  targetBranch?: string;
};

export type ChainStatusRow = {
  id: string;
  display_id: string;
  branch: string;
  ticket: string | null;
  worktree_path: string | null;
  pr: BoardUnit["pr"];
  local: BoardUnit["local"];
  status?: BoardUnit["status"] | undefined;
  state: BoardColumn;
  disposition?: Disposition | undefined;
  reasons: string[];
};

export type ChainStatusResult = {
  source: "chains";
  repo: string;
  remote_freshness: RemoteFreshness;
  rows: ChainStatusRow[];
};

export type GithubProjectConfig = {
  owner: string | null;
  number: number | null;
};

export type NotionAuthMode = "rest" | "claude-mcp" | "notion-cli";

export type NotionIdentityConfig = {
  auth: NotionAuthMode;
  databaseId: string | null;
  idProperty: string | null;
  titleProperty: string | null;
  statusProperty: string | null;
  tokenOpRef: string | null;
  // ai-home-nki04: status-property values that map to a CLOSED work unit
  // (the data source's "complete" group, e.g. ["Completed", "DNF - Did not
  // Complete"]). Configured as a comma-separated `closed_statuses` string
  // because the prx.toml parser is scalar-only. Optional: empty/absent means
  // the resolver leaves `state` as "unknown".
  closedStatuses?: readonly string[];
};

// GH-1421: ticket-tracker source registry. `[sources.<name>]` declarations
// in prx.toml replace the legacy `[identity]` / `[identity.notion]` shape.
// `kind` mirrors `bd`'s sync-backend vocabulary so a future
// `bd sync <kind>` line and a prx source declaration share one word for the
// same concept. The registry-key `name` is a separate dimension so an
// operator can register two sources of the same kind (e.g. `[sources.commerce]`
// and `[sources.product]` both `kind = "notion"`).
export type SourceKind = "github" | "notion";

export const sourceKinds: readonly SourceKind[] = ["github", "notion"];

export type GithubSourceConfig = {
  name: string;
  kind: "github";
  canonicalIdPattern: RegExp;
  source: string;
};

export type NotionSourceConfig = {
  name: string;
  kind: "notion";
  canonicalIdPattern: RegExp;
  source: string;
  notion: NotionIdentityConfig;
};

export type SourceConfig = GithubSourceConfig | NotionSourceConfig;

export type IdentityConfig = {
  sources: Record<string, SourceConfig>;
  // First source declared in the overlay (or base if no overlay). null when
  // the registry was synthesized from a missing-overlay default.
  defaultSourceName: string | null;
  // true iff the registry was synthesized (no `[sources.*]` declarations
  // anywhere). Legacy GH-only repos keep working without an overlay.
  isDefault: boolean;
};

export function findFirstSourceOfKind<K extends SourceKind>(
  config: IdentityConfig,
  kind: K,
): Extract<SourceConfig, { kind: K }> | null {
  for (const src of Object.values(config.sources)) {
    if (src.kind === kind) return src as Extract<SourceConfig, { kind: K }>;
  }
  return null;
}

function unanchorPatternSource(source: string): string {
  return source.replace(/^\^/, "").replace(/\$$/, "");
}

// Effective canonical-id pattern for an IdentityConfig. When the registry is
// synthesized (isDefault), callers should prefer the adapter-registry-wide
// union exposed via `combinedCanonicalIdPattern()` — this fallback is what
// `prx.toml` itself directly declares (GH-only by default).
export function effectiveCanonicalIdPattern(config: IdentityConfig): RegExp {
  const sources = Object.values(config.sources);
  if (sources.length === 0) return canonicalWorkUnitIdPattern;
  if (sources.length === 1) return sources[0]!.canonicalIdPattern;
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const src of sources) {
    const body = unanchorPatternSource(src.canonicalIdPattern.source);
    if (seen.has(body)) continue;
    seen.add(body);
    parts.push(body);
  }
  return new RegExp(`^(${parts.join("|")})$`);
}

export type AgentPlanAction = {
  id: string;
  type: "create" | "delete" | "sync";
  target: "issue" | "branch" | "worktree" | "remote_branch" | "pr";
  command: string;
  reason: string;
  dependencies: string[];
};

export type AgentUnitPlan = {
  id: string;
  state_vector: Record<string, string>;
  expected_state: Record<string, string>;
  diff: {
    additions: string[];
    removals: string[];
  };
  actions: AgentPlanAction[];
};

export type AgentSessionPlan = {
  source: "agent-plan";
  repo: string;
  mode: SurfaceSyncMode;
  authority: SurfaceSyncAuthority;
  scope: SurfaceSyncScope;
  units: AgentUnitPlan[];
};

const issueParityFeatures = [
  "gh_issue",
  "beads_issue",
  "project_item",
  "merge_state",
  "ci",
] as const satisfies readonly SurfaceSyncFeature[];

const issueAuthorityFeatures = [
  "gh_issue",
  "beads_issue",
] as const satisfies readonly SurfaceSyncAuthorityFeature[];

const defaultSurfaceSyncConfig: SurfaceSyncConfig = {
  features: {
    gh_issue: true,
    beads_issue: true,
    project_item: true,
    merge_state: true,
    ci: true,
  },
};

const defaultPrefixRoutingConfig: PrefixRoutingConfig = {
  features: {
    GH: "gh_issue",
  },
};

const defaultGithubProjectConfig: GithubProjectConfig = {
  owner: null,
  number: null,
};

const DEFAULT_SOURCE_PROVENANCE = "<synthesized default>";

function synthesizedDefaultIdentityConfig(): IdentityConfig {
  return {
    sources: {
      github: {
        name: "github",
        kind: "github",
        canonicalIdPattern: canonicalWorkUnitIdPattern,
        source: DEFAULT_SOURCE_PROVENANCE,
      },
    },
    defaultSourceName: "github",
    isDefault: true,
  };
}

function parseBooleanTomlValue(raw: string): boolean | null {
  const value = raw.trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function parseTomlStringValue(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0) {
    return null;
  }
  if (value.startsWith('"')) {
    let escaped = false;
    for (let index = 1; index < value.length; index += 1) {
      const char = value[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        const remainder = value.slice(index + 1).trim();
        if (remainder.length > 0 && !remainder.startsWith("#")) {
          return null;
        }
        try {
          return JSON.parse(value.slice(0, index + 1)) as string;
        } catch {
          return null;
        }
      }
    }
    return null;
  }
  if (value.startsWith("'")) {
    const endIndex = value.indexOf("'", 1);
    if (endIndex < 0) {
      return null;
    }
    const remainder = value.slice(endIndex + 1).trim();
    if (remainder.length > 0 && !remainder.startsWith("#")) {
      return null;
    }
    return value.slice(1, endIndex);
  }
  return null;
}

export function loadSurfaceSyncConfig(
  repoPath: string,
  runner: CommandRunner = defaultRunner,
): SurfaceSyncConfig {
  const root = repoRoot(repoPath, runner);
  const configPath = join(root, "prx.toml");
  if (!existsSync(configPath)) {
    return defaultSurfaceSyncConfig;
  }

  const parsed: SurfaceSyncConfig = {
    features: { ...defaultSurfaceSyncConfig.features },
  };

  let section = "";
  for (const rawLine of readFileSync(configPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const sectionMatch = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1] ?? "";
      continue;
    }
    if (section !== "parity_chain") {
      continue;
    }
    const keyMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!keyMatch) {
      continue;
    }
    const key = keyMatch[1] as SurfaceSyncFeature;
    const value = parseBooleanTomlValue(keyMatch[2] ?? "");
    if (value === null || !issueParityFeatures.includes(key)) {
      continue;
    }
    parsed.features[key] = value;
  }

  return parsed;
}

export function loadPrefixRoutingConfig(
  repoPath: string,
  runner: CommandRunner = defaultRunner,
): PrefixRoutingConfig {
  const root = repoRoot(repoPath, runner);
  const configPath = join(root, "prx.toml");
  if (!existsSync(configPath)) {
    return defaultPrefixRoutingConfig;
  }

  const parsed: PrefixRoutingConfig = {
    features: { ...defaultPrefixRoutingConfig.features },
  };
  let section = "";
  for (const rawLine of readFileSync(configPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const sectionMatch = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1] ?? "";
      continue;
    }
    if (section !== "routing") {
      continue;
    }
    const keyMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!keyMatch) {
      continue;
    }
    const prefix = (keyMatch[1] ?? "").toUpperCase();
    const value = parseTomlStringValue(keyMatch[2] ?? "");
    if (
      !prefix ||
      !value ||
      !issueAuthorityFeatures.includes(value as SurfaceSyncAuthorityFeature)
    ) {
      continue;
    }
    parsed.features[prefix] = value as SurfaceSyncAuthorityFeature;
  }

  return parsed;
}

export function loadGithubProjectConfig(
  repoPath: string,
  runner: CommandRunner = defaultRunner,
): GithubProjectConfig {
  const root = repoRoot(repoPath, runner);
  const configPath = join(root, "prx.toml");
  if (!existsSync(configPath)) {
    return defaultGithubProjectConfig;
  }

  const parsed: GithubProjectConfig = { ...defaultGithubProjectConfig };
  let section = "";
  for (const rawLine of readFileSync(configPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const sectionMatch = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1] ?? "";
      continue;
    }
    if (section !== "project") {
      continue;
    }
    const keyMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!keyMatch) {
      continue;
    }
    if (keyMatch[1] === "owner") {
      const value = parseTomlStringValue(keyMatch[2] ?? "");
      if (value) {
        parsed.owner = value;
      }
      continue;
    }
    if (keyMatch[1] === "number") {
      const raw = (keyMatch[2] ?? "").trim();
      const value = Number.parseInt(raw, 10);
      if (!Number.isNaN(value) && value > 0) {
        parsed.number = value;
      }
    }
  }

  return parsed;
}

type FieldSource<T> = { value: T; source: string };

// GH-1421: per-source raw fields from a single prx.toml file. Each section
// `[sources.<name>]` produces one entry keyed by `<name>`. `keys` carries the
// raw TOML values (no kind/canonical_id_pattern interpretation yet); `source`
// is the file path that declared the section so errors and provenance carry
// `(at <path>)`. Declaration order is preserved on `orderedNames` so the
// loader can pick `defaultSourceName`.
type SourceTomlFields = {
  source: string;
  keys: Record<string, FieldSource<string>>;
};

type IdentityTomlFields = {
  sources: Record<string, SourceTomlFields>;
  orderedNames: string[];
};

function emptyIdentityTomlFields(): IdentityTomlFields {
  return { sources: {}, orderedNames: [] };
}

const SOURCE_SECTION_RE = /^\[sources\.([A-Za-z0-9_-]+)\]$/;
const LEGACY_IDENTITY_SECTION_RE = /^\[identity(?:\.[A-Za-z0-9_-]+)?\]$/;

function parseIdentityTomlFields(text: string, sourcePath: string): IdentityTomlFields {
  const fields = emptyIdentityTomlFields();
  let activeSource: SourceTomlFields | null = null;
  const label = `prx.toml (${sourcePath})`;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const sectionMatch = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (sectionMatch) {
      const header = `[${sectionMatch[1]}]`;
      if (LEGACY_IDENTITY_SECTION_RE.test(header)) {
        throw new Error(
          `${label} ${header} is no longer supported (GH-1421). Replace with [sources.<name>] (kind = "github" | "notion").`,
        );
      }
      const srcMatch = header.match(SOURCE_SECTION_RE);
      if (srcMatch) {
        const name = srcMatch[1]!;
        let existing = fields.sources[name];
        if (!existing) {
          existing = { source: sourcePath, keys: {} };
          fields.sources[name] = existing;
          fields.orderedNames.push(name);
        }
        activeSource = existing;
        continue;
      }
      activeSource = null;
      continue;
    }
    if (activeSource === null) continue;

    const keyMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!keyMatch) continue;
    const rawValue = keyMatch[2] ?? "";
    const raw = parseTomlStringValue(rawValue);
    if (raw === null) {
      throw new Error(
        `${label} [sources.*] ${keyMatch[1]} must be a TOML string, got: ${rawValue}`,
      );
    }
    activeSource.keys[keyMatch[1]!] = { value: raw, source: sourcePath };
  }
  return fields;
}

// Per-source overlay-wins: overlay's `[sources.<name>]` replaces base's
// outright (no key-level merge). Rationale: a source declaration is a self-
// contained unit; partial overrides risk inconsistent state (e.g. overlay
// sets database_id but base sets a regex that no longer matches).
function mergeIdentityTomlFields(
  base: IdentityTomlFields,
  overlay: IdentityTomlFields,
): IdentityTomlFields {
  const sources: Record<string, SourceTomlFields> = { ...base.sources };
  const ordered: string[] = [...base.orderedNames];
  for (const name of overlay.orderedNames) {
    if (!(name in sources)) ordered.push(name);
    sources[name] = overlay.sources[name]!;
  }
  // Reorder: overlay-declared sources come first (defaultSourceName picks
  // the first registered, and the overlay is the operator's stronger
  // intent for which source is the default).
  const overlayFirst: string[] = [
    ...overlay.orderedNames,
    ...ordered.filter((n) => !overlay.orderedNames.includes(n)),
  ];
  return { sources, orderedNames: overlayFirst };
}

// GH-664: Resolve the overlay path for this repo. Layered-config precedent:
// GitHub's system → user → repo → override model. The overlay lives under the
// operator-config root (see operator-config.ts: `PRX_OPERATOR_CONFIG_ROOT` or
// the baked default injected by the nix home-manager wrapper) so we can carry
// per-repo prx config for external repos we don't own
// without touching those repos. Uses the same reverse-DNS layout as
// `~/.local/share/git/repos/io.github/<owner>/<repo>.git/`.
function resolveOperatorOverlayPath(repoPath: string, runner: CommandRunner): string | null {
  const overlayRoot = operatorConfigRoot();
  if (!overlayRoot || overlayRoot.length === 0) {
    return null;
  }

  let originUrl: string;
  try {
    const result = runner(["git", "-C", repoPath, "remote", "get-url", "origin"]);
    if (result.status !== 0) {
      return null;
    }
    originUrl = result.stdout.trim();
  } catch {
    return null;
  }
  if (originUrl.length === 0) {
    return null;
  }

  const segments = reverseDnsRepoSegments(originUrl);
  if (!segments) {
    return null;
  }

  return join(overlayRoot, ".prx", "repos", ...segments, "prx.toml");
}

// Reject path-unsafe segments. Origin URLs are operator-trusted but not
// filesystem-sanitized, so any weird `.` / `..` / separator / NUL gets
// turned into "no overlay" rather than escaping the .prx/repos/ subtree.
export function isSafePathSegment(s: string): boolean {
  return (
    s.length > 0 &&
    s !== "." &&
    s !== ".." &&
    !s.includes("/") &&
    !s.includes("\\") &&
    !s.includes("\0")
  );
}

// Host segment is looked up via `hostSegmentForHost` (repos.ts) — the same
// map `canonicalBarePathForRepo`/`canonicalWorktreePathForRepo` use, so a
// host only needs to be taught here once. Unlisted hosts return null so the
// overlay is silently skipped, same as before this was generalized.
//
// Filesystem placement ONLY — the overlay directory is resolved fresh from
// the current origin on every call, so it's safe for this to follow the
// current host-segment convention. Do NOT reuse this for anything whose
// output gets hashed or persisted as a stable identity (dolt database
// names, dolt server ids, workspace ledger ids) — those need
// `legacyGithubIdentitySegments` below, pinned forever, or existing live
// state (running dolt servers, on-disk ledgers) silently orphans the day
// the filesystem convention changes.
export function reverseDnsRepoSegments(originUrl: string): [string, string, string] | null {
  const parsed = parseRepoUrl(originUrl);
  if (!parsed) {
    return null;
  }
  const hostSegment = hostSegmentForHost(parsed.host);
  if (!hostSegment) {
    return null;
  }
  const { owner, name } = parsed;
  if (!isSafePathSegment(owner) || !isSafePathSegment(name)) {
    return null;
  }
  return [hostSegment, owner, name];
}

// Pinned identity segments for GitHub origins — always `io.github`, forever,
// regardless of what `hostSegmentForHost` (repos.ts) derives for filesystem
// placement. Anything that hashes or persists this value as a stable id
// (dolt database names, dolt server ids, workspace ledger ids) must import
// this, not `reverseDnsRepoSegments`: those consumers key already-existing
// external/on-disk state by the hash, and changing the input silently
// orphans it (a live dolt sql-server, a database, a ledger file) rather
// than failing loudly. Deliberately GitHub-only, matching the historical
// scope of every consumer today.
export function legacyGithubIdentitySegments(originUrl: string): [string, string, string] | null {
  const ownerRepo = parseGithubRepo(originUrl);
  if (!ownerRepo) {
    return null;
  }
  const parts = ownerRepo.split("/");
  if (parts.length !== 2) {
    return null;
  }
  const [owner, repo] = parts;
  if (!owner || !repo || !isSafePathSegment(owner) || !isSafePathSegment(repo)) {
    return null;
  }
  return ["io.github", owner, repo];
}

// E0 of GH-1685 — canonical per-repo `dolt_database` name in the live
// reverse-DNS shape `io_github_<owner>_<repo>` (D0). Joins the pinned
// identity segments (see `legacyGithubIdentitySegments`) and collapses each
// non-alphanumeric run to a single `_` (`bounded-systems` → `bounded_systems`,
// `supply-plan-design` → `supply_plan_design`). Returns null when the origin
// isn't a GitHub owner/repo, or when the sanitized result isn't a valid
// database name. The name is intentionally not reversible into owner/repo —
// always derive forward from the origin (see DOLT_DATABASE_NAME_PATTERN in
// dolt/schema.ts). MUST stay pinned to `io_github_...` — this names live
// dolt databases already created under that scheme; changing it silently
// orphans them rather than failing loudly.
export function canonicalDoltDatabase(originUrl: string): string | null {
  const segments = legacyGithubIdentitySegments(originUrl);
  if (!segments) {
    return null;
  }
  const name = segments
    .join("_")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return DOLT_DATABASE_NAME_PATTERN.test(name) ? name : null;
}

export function parseGithubRepo(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }

  const sshMatch = trimmed.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return sshMatch[1] ?? null;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname !== "github.com") {
      return null;
    }
    const repoPath = parsed.pathname.replace(/^\/+/, "").replace(/\.git$/, "");
    if (repoPath.length === 0) {
      return null;
    }
    const parts = repoPath.split("/");
    // Only accept URLs with exactly owner/repo; anything deeper (e.g.
    // `/owner/repo/tree/main`) is not a clone URL.
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return null;
    }
    return `${parts[0]}/${parts[1]}`;
  } catch {
    return null;
  }
}

// ai-home-nki04: `closed_statuses` is a comma-separated scalar string (the
// prx.toml parser does not support TOML arrays). Status names containing a
// literal comma are unsupported.
function parseClosedStatuses(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function buildSourceConfig(name: string, raw: SourceTomlFields): SourceConfig {
  const label = `prx.toml [sources.${name}]`;
  const provenance = `at ${raw.source}`;
  const rawKind = raw.keys["kind"];
  if (!rawKind || rawKind.value.length === 0) {
    throw new Error(`${label} kind is required (${provenance})`);
  }
  if (rawKind.value === "dolt") {
    throw new Error(
      `${label} kind = "dolt" is not yet a recognised resolver — see GH-852 (${provenance})`,
    );
  }
  if (!sourceKinds.includes(rawKind.value as SourceKind)) {
    throw new Error(
      `${label} kind must be one of ${sourceKinds.join(", ")}, got: ${rawKind.value} (${provenance})`,
    );
  }
  const kind = rawKind.value as SourceKind;

  const rawPattern = raw.keys["canonical_id_pattern"];
  if (!rawPattern || rawPattern.value.length === 0) {
    throw new Error(`${label} canonical_id_pattern is required (${provenance})`);
  }
  let canonicalIdPattern: RegExp;
  try {
    canonicalIdPattern = new RegExp(rawPattern.value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${label} canonical_id_pattern is not a valid regex: ${rawPattern.value} (${message}) (at ${rawPattern.source})`,
    );
  }

  if (kind === "github") {
    return { name, kind, canonicalIdPattern, source: raw.source };
  }

  // kind === "notion"
  const rawAuth = raw.keys["auth"];
  let auth: NotionAuthMode;
  if (rawAuth === undefined) {
    auth = "rest";
  } else if (
    rawAuth.value === "rest" ||
    rawAuth.value === "claude-mcp" ||
    rawAuth.value === "notion-cli"
  ) {
    auth = rawAuth.value;
  } else {
    throw new Error(
      `${label} auth must be "rest", "claude-mcp", or "notion-cli", got: ${rawAuth.value} (at ${rawAuth.source})`,
    );
  }

  const rawTokenOpRef = raw.keys["token_op_ref"];
  let tokenOpRef: string | null = null;
  if (rawTokenOpRef && rawTokenOpRef.value.length > 0) {
    const value = rawTokenOpRef.value;
    const segments = value.startsWith("op://") ? value.slice(5).split("/") : null;
    if (segments === null || segments.length < 3 || segments.some((seg) => seg.length === 0)) {
      throw new Error(
        `${label} token_op_ref must be an op:// URI of the form "op://<vault>/<item>/<field>", got: ${value} (at ${rawTokenOpRef.source})`,
      );
    }
    tokenOpRef = value;
  }

  if (auth === "rest") {
    for (const required of ["database_id", "id_property", "title_property"] as const) {
      const value = raw.keys[required];
      if (!value || value.value.length === 0) {
        throw new Error(`${label} ${required} is required when auth = "rest" (${provenance})`);
      }
    }
    return {
      name,
      kind,
      canonicalIdPattern,
      source: raw.source,
      notion: {
        auth,
        databaseId: raw.keys["database_id"]!.value,
        idProperty: raw.keys["id_property"]!.value,
        titleProperty: raw.keys["title_property"]!.value,
        statusProperty: raw.keys["status_property"]?.value ?? null,
        tokenOpRef,
        closedStatuses: parseClosedStatuses(raw.keys["closed_statuses"]?.value),
      },
    };
  }

  return {
    name,
    kind,
    canonicalIdPattern,
    source: raw.source,
    notion: {
      auth,
      databaseId: raw.keys["database_id"]?.value ?? null,
      idProperty: raw.keys["id_property"]?.value ?? null,
      titleProperty: raw.keys["title_property"]?.value ?? null,
      statusProperty: raw.keys["status_property"]?.value ?? null,
      tokenOpRef,
      closedStatuses: parseClosedStatuses(raw.keys["closed_statuses"]?.value),
    },
  };
}

export function loadIdentityConfig(
  repoPath: string,
  runner: CommandRunner = defaultRunner,
): IdentityConfig {
  let root: string;
  try {
    root = repoRoot(repoPath, runner);
  } catch {
    return synthesizedDefaultIdentityConfig();
  }
  const configPath = join(root, "prx.toml");
  const baseFields = existsSync(configPath)
    ? parseIdentityTomlFields(readFileSync(configPath, "utf8"), configPath)
    : emptyIdentityTomlFields();

  const overlayPath = resolveOperatorOverlayPath(repoPath, runner);
  const overlayFields =
    overlayPath && existsSync(overlayPath)
      ? parseIdentityTomlFields(readFileSync(overlayPath, "utf8"), overlayPath)
      : emptyIdentityTomlFields();

  const merged = mergeIdentityTomlFields(baseFields, overlayFields);
  if (merged.orderedNames.length === 0) {
    return synthesizedDefaultIdentityConfig();
  }

  const sources: Record<string, SourceConfig> = {};
  for (const name of merged.orderedNames) {
    sources[name] = buildSourceConfig(name, merged.sources[name]!);
  }
  return {
    sources,
    defaultSourceName: merged.orderedNames[0] ?? null,
    isDefault: false,
  };
}

export type WorkspaceConfig = {
  track: boolean;
};

const defaultWorkspaceConfig: WorkspaceConfig = { track: true };

export function loadWorkspaceConfig(
  repoPath: string,
  runner: CommandRunner = defaultRunner,
): WorkspaceConfig {
  let root: string;
  try {
    root = repoRoot(repoPath, runner);
  } catch {
    return defaultWorkspaceConfig;
  }
  const configPath = join(root, "prx.toml");
  if (!existsSync(configPath)) {
    return defaultWorkspaceConfig;
  }

  let section = "";
  for (const rawLine of readFileSync(configPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const sectionMatch = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1] ?? "";
      continue;
    }
    if (section !== "workspace") {
      continue;
    }
    const keyMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!keyMatch || keyMatch[1] !== "track") {
      continue;
    }
    const rawValue = (keyMatch[2] ?? "").trim();
    const value = parseBooleanTomlValue(rawValue);
    if (value === null) {
      throw new Error(
        `prx.toml [workspace] track must be a boolean (true|false), got: ${rawValue}`,
      );
    }
    return { track: value };
  }
  return defaultWorkspaceConfig;
}

// Idempotent: upserts `[workspace] track = <value>` in the repo's prx.toml,
// preserving other sections. Creates the file if it does not yet exist.
export function persistWorkspaceTrack(repoRoot: string, track: boolean): void {
  const configPath = join(repoRoot, "prx.toml");
  const desired = `track = ${track ? "true" : "false"}`;

  // Read once (empty on missing) instead of existsSync-then-read, so the
  // later writeFileSync isn't racing an existence check (CodeQL
  // js/file-system-race).
  let existing = "";
  try {
    existing = readFileSync(configPath, "utf8");
  } catch {
    existing = "";
  }
  if (existing.length === 0) {
    writeFileSync(configPath, `[workspace]\n${desired}\n`);
    return;
  }

  const lines = existing.split("\n");
  const hadTrailingNewline = existing.endsWith("\n");
  if (hadTrailingNewline && lines[lines.length - 1] === "") {
    lines.pop();
  }

  let workspaceIdx = -1;
  let trackIdx = -1;
  let nextSectionIdx = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]!.trim();
    const sectionMatch = trimmed.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (sectionMatch) {
      if (sectionMatch[1] === "workspace") {
        workspaceIdx = index;
        trackIdx = -1;
        nextSectionIdx = lines.length;
      } else if (workspaceIdx >= 0 && nextSectionIdx === lines.length) {
        nextSectionIdx = index;
      }
      continue;
    }
    if (workspaceIdx >= 0 && index > workspaceIdx && index < nextSectionIdx) {
      if (/^track\s*=/.test(trimmed)) {
        trackIdx = index;
      }
    }
  }

  if (trackIdx >= 0) {
    lines[trackIdx] = desired;
  } else if (workspaceIdx >= 0) {
    lines.splice(workspaceIdx + 1, 0, desired);
  } else {
    if (lines.length > 0 && lines[lines.length - 1] !== "") {
      lines.push("");
    }
    lines.push("[workspace]", desired);
  }

  writeFileSync(configPath, `${lines.join("\n")}\n`);
}

// Routing operates on the raw branch/id prefix (KEY-NUM) so that legacy
// non-GH prefixes from prx.toml [routing] continue to resolve during the
// migration to GH-canonical identity. Canonical validation (GH-only) lives
// in canonicalWorkUnitIdFromBranchName and is kept independent.
function listRemoteBranches(repoPath: string, runner: CommandRunner = defaultRunner): string[] {
  const result = runner(["git", "-C", repoPath, "branch", "--list", "-r"], { check: false });
  if (result.status !== 0) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes("->"))
    .map((line) => line.replace(/^origin\//, ""))
    .filter((line) => line.length > 0);
}

function listLocalBranches(repoPath: string, runner: CommandRunner = defaultRunner): string[] {
  const result = runner(["git", "-C", repoPath, "branch", "--format=%(refname:short)"], {
    check: false,
  });
  if (result.status !== 0) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function safeRun(runner: CommandRunner, cmd: string[]): CommandResult | null {
  try {
    return runner(cmd, { check: false });
  } catch {
    // Runner mocks in some tests throw on unknown commands; treat that
    // as "unavailable" so the authorship gate fails open rather than
    // tearing down board reads.
    return null;
  }
}

/**
 * GH-914: read the operator's git identity for HEAD authorship gating.
 * Returns null when neither `user.email` nor `user.name` is configured —
 * callers fail open and emit destructive actions as before.
 */
export function getOperatorIdentity(
  repoPath: string,
  runner: CommandRunner = defaultRunner,
): { name: string; email: string } | null {
  const emailResult = safeRun(runner, ["git", "-C", repoPath, "config", "--get", "user.email"]);
  const nameResult = safeRun(runner, ["git", "-C", repoPath, "config", "--get", "user.name"]);
  const email = emailResult && emailResult.status === 0 ? emailResult.stdout.trim() : "";
  const name = nameResult && nameResult.status === 0 ? nameResult.stdout.trim() : "";
  if (email.length === 0 && name.length === 0) {
    return null;
  }
  return { name, email };
}

/**
 * GH-914: batched read of HEAD authorship for every remote branch under
 * `refs/remotes/origin/`. One `git for-each-ref` call covers all
 * remote-only Pass 3 units; we then look up by short branch name.
 * Email is normalized (`<>` stripped, lowercased) for the operator
 * comparison.
 */
export function readRemoteBranchAuthors(
  repoPath: string,
  runner: CommandRunner = defaultRunner,
): Map<string, { name: string; email: string }> {
  const out = new Map<string, { name: string; email: string }>();
  const result = safeRun(runner, [
    "git",
    "-C",
    repoPath,
    "for-each-ref",
    "--format=%(refname:short)\t%(authoremail)\t%(authorname)",
    "refs/remotes/origin/",
  ]);
  if (!result || result.status !== 0) {
    return out;
  }
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const [refnameRaw, emailRaw, nameRaw] = line.split("\t");
    if (!refnameRaw || !emailRaw) continue;
    const refname = refnameRaw.trim();
    if (refname === "origin/HEAD" || refname.includes("->")) continue;
    const branch = refname.replace(/^origin\//, "");
    if (branch.length === 0) continue;
    const email = emailRaw.trim().replace(/^<|>$/g, "").toLowerCase();
    const name = (nameRaw ?? "").trim();
    out.set(branch, { name, email });
  }
  return out;
}

function compareOperatorIdentity(
  operator: { name: string; email: string } | null,
  branch: { name: string; email: string },
): boolean | null {
  if (!operator) return null;
  const opEmail = operator.email.trim().toLowerCase();
  if (opEmail.length > 0 && branch.email.length > 0) {
    return opEmail === branch.email;
  }
  const opName = operator.name.trim();
  if (opName.length > 0 && branch.name.length > 0) {
    return opName === branch.name;
  }
  return null;
}

/**
 * GH-868: resolve the bare-repo path for the `local` buffer remote.
 *
 * The buffer is a file-based bare repo at `~/.local/state/git/buffer/<owner>/<repo>.git`
 * and enforces `receive.denyDeletes = true`, so `git push local --delete` is
 * rejected. To prune merged branches off the buffer we instead operate
 * directly on the bare repo via `git -C <buffer-path> branch -D`.
 *
 * Returns null when:
 *  - the `local` remote is not configured,
 *  - the URL is not a `file://` scheme, or
 *  - the resolved path is outside `~/.local/state/git/buffer/`
 *    (i.e. a hand-rolled `local` remote we must not touch).
 */
function resolveBufferRepoPath(
  repoPath: string,
  runner: CommandRunner = defaultRunner,
): string | null {
  const result = runner(["git", "-C", repoPath, "remote", "get-url", "local"], { check: false });
  if (result.status !== 0) {
    return null;
  }
  const url = result.stdout.trim();
  if (!url.startsWith("file://")) {
    return null;
  }
  const path = url.slice("file://".length);
  const bufferPrefix = `${homeDir()}/.local/state/git/buffer/`;
  if (!path.startsWith(bufferPrefix)) {
    return null;
  }
  return path;
}

export type IssueView = {
  number: number;
  state?: string | null;
};

type BeadsIssueView = {
  id: string;
  status?: string | null;
};

type ProjectItemView = {
  count: number;
};

// GH-2074 PR-3 (.3.2): issue read projection. `{ view }` wraps the value so a
// null view (no GH issue / fetch failed) is distinguishable from an absent unit.
type IssueSnapshot = { view: IssueView | null };

/**
 * Pure issue read seam — reads the hydrated projection (scope = repo slug,
 * key = ticket). Holds NO CommandRunner; never shells out. Raises
 * {@link ProjectionMiss} when the unit was not hydrated — the caller must call
 * {@link hydrateIssue} first (ai-home-udqx2.12). A null return means "no GH
 * issue", which is distinct from a miss.
 */
export function maybeViewIssue(repo: string, ticket: string | null): IssueView | null {
  if (!ticket) {
    return null;
  }
  const snap = getUnit<IssueSnapshot>(repo, ticket);
  if (snap === null) {
    throw new ProjectionMiss(ticket, "gh-issue");
  }
  return snap.view;
}

/**
 * Issue hydration actor — the sole CommandRunner holder for the issue
 * projection. Fresh-or-fetch: a no-op when the unit is already fresh (TTL),
 * else runs `gh issue view` once and stores the snapshot. Always stores a
 * snapshot (a non-matching ticket / failed fetch stores `{ view: null }`) so the
 * subsequent pure read never misses.
 */
// The live `gh issue view` fetch — shared by the hydration actor (board path)
// and the fresh read (close path). The sole place this argv is built.
function fetchIssueLive(
  repo: string,
  ticket: string | null,
  runner: CommandRunner,
): IssueView | null {
  const match = ticket?.match(/-(\d+)$/);
  if (!ticket || !match) {
    return null;
  }
  const result = runner(["gh", "issue", "view", match[1]!, "--json", "number,state", "-R", repo], {
    check: false,
  });
  if (result.status !== 0) {
    return null;
  }
  try {
    return JSON.parse(result.stdout) as IssueView;
  } catch {
    return null;
  }
}

export function hydrateIssue(
  repo: string,
  ticket: string | null,
  runner: CommandRunner = defaultRunner,
): void {
  if (!ticket) {
    return;
  }
  if (!projectionBypass() && getUnit<IssueSnapshot>(repo, ticket) !== null) {
    return;
  }
  putUnit<IssueSnapshot>(repo, ticket, { view: fetchIssueLive(repo, ticket, runner) });
}

/**
 * Fresh, un-cached `gh issue view` — for callers that need *current* state, not
 * a TTL projection: the close-idempotency / postmerge probes ("is this issue
 * already closed?"). A cached answer there could act on stale state, so these
 * deliberately bypass the projection (ai-home-udqx2.12).
 */
export function viewIssueFresh(
  repo: string,
  ticket: string | null,
  runner: CommandRunner = defaultRunner,
): IssueView | null {
  return fetchIssueLive(repo, ticket, runner);
}

function maybeLoadTaskBeadId(worktreePath: string | null): string | null {
  if (!worktreePath) {
    return null;
  }
  const taskPath = join(worktreePath, ".pr", "local", "task.json");
  if (!taskContractExists(taskPath)) {
    return null;
  }
  try {
    return loadTaskContract(taskPath).identity.beadId ?? null;
  } catch {
    return null;
  }
}

// GH-2074 PR-3 (.3.2): beads read projection (scope = repoPath, key = beadId).
type BeadsSnapshot = { view: BeadsIssueView | null };

/**
 * Pure beads read seam — reads the hydrated projection. No CommandRunner; never
 * shells out. Raises {@link ProjectionMiss} when not hydrated (call
 * {@link hydrateBeads} first). Null return = "no bead", distinct from a miss.
 */
export function maybeViewBeadsIssue(
  repoPath: string,
  beadId: string | null,
): BeadsIssueView | null {
  if (!beadId) {
    return null;
  }
  const snap = getUnit<BeadsSnapshot>(repoPath, beadId);
  if (snap === null) {
    throw new ProjectionMiss(beadId, "bd-show");
  }
  return snap.view;
}

/**
 * Beads hydration actor — the sole CommandRunner holder for the beads
 * projection. Fresh-or-fetch: no-op when fresh, else runs `bd show` once and
 * stores the snapshot (failed/empty → `{ view: null }`).
 */
export function hydrateBeads(
  repoPath: string,
  beadId: string | null,
  runner: CommandRunner = defaultRunner,
): void {
  if (!beadId) {
    return;
  }
  if (!projectionBypass() && getUnit<BeadsSnapshot>(repoPath, beadId) !== null) {
    return;
  }
  // Beads retired (GH-1012): there is no bd read plane to hydrate from anymore
  // (GitHub is the write plane, Front Desk the read plane). Store an absent
  // snapshot so downstream readers resolve to "no bead" instead of a
  // projection miss. The `runner` seam is kept for signature stability.
  void runner;
  putUnit<BeadsSnapshot>(repoPath, beadId, { view: null });
}

function maybeViewProjectItems(
  repo: string,
  ticket: string | null,
  runner: CommandRunner = defaultRunner,
): ProjectItemView | null {
  if (!ticket) {
    return null;
  }
  const issueMatch = ticket.match(/-(\d+)$/);
  if (!issueMatch) {
    return null;
  }
  const [owner, name] = repo.split("/", 2);
  if (!owner || !name) {
    return null;
  }
  const query = [
    "query($owner:String!,$name:String!,$number:Int!){",
    "repository(owner:$owner,name:$name){",
    "issue(number:$number){",
    "projectItems(first:20){nodes{id}}",
    "}",
    "}",
    "}",
  ].join("");
  const result = runner(
    [
      "gh",
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      "-F",
      `number=${issueMatch[1]!}`,
    ],
    { check: false },
  );
  if (result.status !== 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(result.stdout) as {
      data?: {
        repository?: {
          issue?: { projectItems?: { nodes?: Array<{ id?: string | null }> | null } | null } | null;
        } | null;
      };
    };
    const count = parsed.data?.repository?.issue?.projectItems?.nodes?.length ?? 0;
    return { count };
  } catch {
    return null;
  }
}

function latestPrForBranch(
  repo: string,
  branch: string,
  runner: CommandRunner = defaultRunner,
): PrView | null {
  const result = runner(
    [
      "gh",
      "pr",
      "list",
      "--state",
      "all",
      "--head",
      branch,
      "--limit",
      "1",
      "--json",
      "number,state,isDraft,title,url,headRefName,reviewDecision,statusCheckRollup,mergeable,reviews",
      "-R",
      repo,
    ],
    { check: false },
  );
  if (result.status !== 0) {
    return null;
  }
  try {
    const prs = JSON.parse(result.stdout) as PrView[];
    return prs[0] ?? null;
  } catch {
    return null;
  }
}

function localBranchExists(
  repoPath: string,
  branch: string,
  runner: CommandRunner = defaultRunner,
): boolean {
  const result = runner(
    ["git", "-C", repoPath, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { check: false },
  );
  return result.status === 0;
}

function refStatusAgainstMain(
  repoPath: string,
  ref: string,
  runner: CommandRunner = defaultRunner,
): string {
  const result = runner(
    ["git", "-C", repoPath, "rev-list", "--left-right", "--count", `origin/main...${ref}`],
    { check: false },
  );
  if (result.status !== 0) {
    return "missing";
  }
  const match = result.stdout.trim().match(/^(\d+)\s+(\d+)$/);
  if (!match) {
    return "unknown";
  }
  const behind = Number.parseInt(match[1]!, 10);
  const ahead = Number.parseInt(match[2]!, 10);
  const sync = summarizeSync("origin/main", ahead, behind);
  if (sync === "up_to_date") {
    return "clean";
  }
  return "dirty";
}

function prLifecycleLabel(pr: PrView | null): string {
  if (!pr) {
    return "clean";
  }
  const state = (pr.state ?? "").toUpperCase();
  if (state === "MERGED") {
    return "completed";
  }
  if (pr.isDraft) {
    return "dirty";
  }
  if (state === "OPEN") {
    return "dirty";
  }
  if (state === "CLOSED") {
    return "completed";
  }
  return "unknown";
}

export function prMergeStateLabel(pr: PrView | null): string {
  if (!pr) {
    return "clean";
  }
  const state = (pr.state ?? "").toUpperCase();
  if (pr.isDraft) {
    return "draft";
  }
  if (state === "OPEN") {
    return "open";
  }
  if (state === "MERGED") {
    return "merged";
  }
  if (state === "CLOSED") {
    return "closed";
  }
  return "unknown";
}

function issueLifecycleLabel(issue: IssueView | null, ticket: string | null): string {
  if (!ticket) {
    return "clean";
  }
  if (!issue) {
    return "unknown";
  }
  return (issue.state ?? "").toUpperCase() === "OPEN" ? "dirty" : "completed";
}

function beadsIssueLifecycleLabel(issue: BeadsIssueView | null, beadId: string | null): string {
  if (!beadId) {
    return "clean";
  }
  if (!issue) {
    return "unknown";
  }
  const status = (issue.status ?? "").toLowerCase();
  if (status === "closed") {
    return "completed";
  }
  if (status.length === 0) {
    return "unknown";
  }
  return "dirty";
}

function projectItemLifecycleLabel(item: ProjectItemView | null, ticket: string | null): string {
  if (!ticket) {
    return "clean";
  }
  if (!item) {
    return "unknown";
  }
  return item.count > 0 ? "dirty" : "clean";
}

function ciLifecycleLabel(
  checks: BoardUnit["pr"]["checks"] | ReturnType<typeof summarizeChecks> | null | undefined,
): string {
  if (checks === "green") {
    return "passed";
  }
  if (checks === "pending") {
    return "running";
  }
  if (checks === "red") {
    return "failed";
  }
  return "unknown";
}

function remoteStatusForUnit(
  repoPath: string,
  repo: string,
  branch: string,
  ticket: string | null,
  beadId: string | null,
  explicitPr: BoardUnit["pr"],
  config: SurfaceSyncConfig,
  runner: CommandRunner = defaultRunner,
): NonNullable<BoardUnit["status"]>["remote"] {
  // GH-2074 PR-3 (.3.2): hydrate-then-read. The hydration actors hold the
  // runner (fresh-or-fetch); the read seams are pure.
  if (issueParityFeatureEnabled(config, "gh_issue")) hydrateIssue(repo, ticket, runner);
  if (issueParityFeatureEnabled(config, "beads_issue")) hydrateBeads(repoPath, beadId, runner);
  const ghIssue = issueParityFeatureEnabled(config, "gh_issue")
    ? maybeViewIssue(repo, ticket)
    : null;
  const beadsIssue = issueParityFeatureEnabled(config, "beads_issue")
    ? maybeViewBeadsIssue(repoPath, beadId)
    : null;
  const projectItem = issueParityFeatureEnabled(config, "project_item")
    ? maybeViewProjectItems(repo, ticket, runner)
    : null;
  const latestPr = explicitPr.exists
    ? ({
        number: explicitPr.number!,
        state: "OPEN",
        isDraft: explicitPr.draft ?? false,
      } as PrView)
    : latestPrForBranch(repo, branch, runner);
  const ghIssueStatus = issueParityFeatureEnabled(config, "gh_issue")
    ? issueLifecycleLabel(ghIssue, ticket)
    : "disabled";
  const beadsIssueStatus = issueParityFeatureEnabled(config, "beads_issue")
    ? beadsIssueLifecycleLabel(beadsIssue, beadId)
    : "disabled";
  const projectItemStatus = issueParityFeatureEnabled(config, "project_item")
    ? projectItemLifecycleLabel(projectItem, ticket)
    : "disabled";
  const remoteBranchStatus = refStatusAgainstMain(repoPath, `origin/${branch}`, runner);
  const bufferBranchStatus = refStatusAgainstMain(repoPath, `local/${branch}`, runner);
  const prStatus = prLifecycleLabel(latestPr);
  const mergeState = issueParityFeatureEnabled(config, "merge_state")
    ? prMergeStateLabel(latestPr)
    : "disabled";
  const ciStatus = issueParityFeatureEnabled(config, "ci")
    ? explicitPr.exists
      ? ciLifecycleLabel(explicitPr.checks)
      : ciLifecycleLabel(latestPr ? summarizeChecks(latestPr.statusCheckRollup) : null)
    : "disabled";
  const completedLifecycle =
    (issueParityFeatureEnabled(config, "gh_issue") && ghIssueStatus === "completed") ||
    (issueParityFeatureEnabled(config, "beads_issue") && beadsIssueStatus === "completed") ||
    prStatus === "completed";

  return {
    gh_issue: ghIssueStatus,
    beads_issue: beadsIssueStatus,
    project_item: projectItemStatus,
    branch: remoteBranchStatus,
    buffer_branch: bufferBranchStatus,
    pr: prStatus,
    merge_state: mergeState,
    ci: ciStatus,
    problem: completedLifecycle && remoteBranchStatus === "dirty" ? "yes" : "no",
  };
}

function localStatusForUnit(
  repoPath: string,
  branch: string,
  unit: Omit<BoardUnit, "column" | "reasons">,
  worktreeMismatch: boolean,
  runner: CommandRunner = defaultRunner,
): NonNullable<BoardUnit["status"]>["local"] {
  const branchExists = localBranchExists(repoPath, branch, runner);
  const localBranchStatus = branchExists
    ? refStatusAgainstMain(repoPath, `refs/heads/${branch}`, runner)
    : "clean";
  const worktreeStatus = unit.worktree_path
    ? localBranchStatus === "dirty" || unit.local.clean === false
      ? "dirty"
      : "clean"
    : "clean";
  const localDirStatus = worktreeMismatch
    ? "wrong worktree"
    : unit.worktree_path
      ? "present"
      : branchExists
        ? "no worktree"
        : "missing";
  const localProblem =
    localBranchStatus === "dirty" ||
    worktreeStatus === "dirty" ||
    localDirStatus === "wrong worktree";

  return {
    branch: localBranchStatus,
    worktree: worktreeStatus,
    dir: localDirStatus,
    problem: localProblem ? "yes" : "no",
  };
}

function buildWorktreePath(repoPath: string, branch: string): string {
  return resolve(repoPath, "..", branch);
}

function shellEscape(arg: string): string {
  if (arg === "") {
    return "''";
  }

  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

function shellCommand(...args: string[]): string {
  return args.map((arg) => shellEscape(arg)).join(" ");
}

function createWorktreeCommand(repoPath: string, branch: string): string {
  return shellCommand("git", "worktree", "add", buildWorktreePath(repoPath, branch), branch);
}

/**
 * Executor side of the surface-sync action spec: map an env-agnostic intent to
 * a shell command using execution context. This is "github.ts implements the
 * spec"; surface-sync only produces the intents. See
 * docs/architecture/surface-sync-extraction.md (Stage 2b).
 */
export type SurfaceSyncExecContext = {
  repoPath: string;
  bufferPath: string | null;
};

/** Acquire execution context for the surface-sync executor from a repo path. */
export function surfaceSyncExecContext(
  repoPath: string,
  runner: CommandRunner = defaultRunner,
): SurfaceSyncExecContext {
  return {
    repoPath,
    bufferPath: resolveBufferRepoPath(repoPath, runner),
  };
}

export function commandForSurfaceSyncAction(
  action: SurfaceSyncAction,
  ctx: SurfaceSyncExecContext,
): string {
  switch (action.type) {
    case "delete_remote_branch":
      return action.remote === "local"
        ? shellCommand("git", "-C", ctx.bufferPath ?? ".", "branch", "-D", action.branch)
        : shellCommand("git", "push", "origin", "--delete", action.branch);
    case "delete_local_branch":
      return shellCommand("git", "branch", "-D", action.branch);
    case "delete_worktree":
      return shellCommand(
        "prx",
        "worktree-remove",
        action.ticket ?? action.branch,
        "--delete-branch",
      );
    case "create_local_branch":
      return shellCommand("git", "branch", action.branch, "origin/main");
    case "create_worktree":
      return createWorktreeCommand(ctx.repoPath, action.branch);
    case "push_remote_branch":
      return shellCommand("git", "push", "-u", "origin", action.branch);
    case "open_pr":
      return shellCommand(
        "gh",
        "pr",
        "create",
        "--head",
        action.branch,
        "--base",
        "main",
        "--draft",
      );
    case "close_issue": {
      const prRef = action.pr !== null ? `#${action.pr}` : null;
      return shellCommand(
        "gh",
        "issue",
        "close",
        String(action.issue),
        "-c",
        `Shipped via ${prRef ?? "linked merged PR"}. Auto-closed by 'prx prune --merged-only'.`,
      );
    }
  }
}

export type FallbackIssueLabel = {
  name: string;
};

export type FallbackIssue = {
  number: number;
  title: string;
  url: string;
  labels?: FallbackIssueLabel[] | undefined;
};

export type SyncGitHubIssuesToBeadsResult = {
  exitCode: number;
  lines: string[];
};

type GitHubIdentityAuditResult = {
  exitCode: number;
  lines: string[];
};

function enforceGitHubIssueIdentity(
  _root: string,
  _repo: string,
  _apply: boolean,
  _runner: CommandRunner,
): GitHubIdentityAuditResult {
  // Beads retired (GH-1012): the canonical-identity audit reconciled the bead
  // set (read via the retired `bd list`) against GitHub issues. With no bd read
  // plane there is nothing to reconcile, so the audit is a no-op that reports
  // success. GitHub is now the sole identity authority.
  return {
    exitCode: 0,
    lines: ["OK GitHub identity check skipped (beads retired)."],
  };
}

function normalizeWtState(state: WtState): NormalizedWtState {
  const branch =
    typeof state.branch === "string" && state.branch.trim().length > 0 ? state.branch : "MAIN";
  const working = state.working_tree ?? {};
  const dirtyFlags = [
    working.staged ? "staged" : null,
    working.modified ? "modified" : null,
    working.untracked ? "untracked" : null,
    working.deleted ? "deleted" : null,
    working.renamed ? "renamed" : null,
  ].filter(Boolean) as string[];
  const clean = dirtyFlags.length === 0;

  const ahead = state.remote?.ahead ?? 0;
  const behind = state.remote?.behind ?? 0;
  const sync = summarizeSync("origin", ahead, behind);
  const rawStates = state.worktree?.state;
  const states = Array.isArray(rawStates)
    ? rawStates
    : typeof rawStates === "string" && rawStates.length > 0
      ? [rawStates]
      : [];
  const mismatch = states.includes("branch_worktree_mismatch");
  const rawSymbols = state.symbols;
  const symbols = Array.isArray(rawSymbols)
    ? rawSymbols
    : typeof rawSymbols === "string" && rawSymbols.length > 0
      ? Array.from(rawSymbols.trim()).filter((symbol) => symbol.trim().length > 0)
      : [];

  return {
    branch,
    path: state.path,
    integration: state.main_state,
    clean,
    dirty_flags: dirtyFlags,
    sync: {
      ahead,
      behind,
      state: sync,
    },
    structural: {
      detached: state.worktree?.detached ?? false,
      mismatch,
      states,
    },
    symbols,
    symbol_meanings: symbols
      .map((symbol) => wtSymbolLegend[symbol as keyof typeof wtSymbolLegend])
      .filter(Boolean),
    commit: {
      sha: state.commit?.sha ?? null,
      message: state.commit?.message ?? null,
    },
  };
}

// GH-705: concurrent Claude sessions each call `prx statusline`, which fans out
// the worktree-status read + `git fetch --dry-run` per session. The worktree
// read walks every worktree (including mainx) running a `git status` per tree,
// briefly locking their index.lock files and colliding with `prx session open`.
// Caching these two read-only probes on disk, keyed by the shared git common
// dir, lets all concurrent sessions of the same repo reuse a single fan-out per
// TTL window.
type WtCacheEntry<T> = { version: 1; writtenAt: number; value: T };

const WT_CACHE_VERSION = 1;
const WT_CACHE_DEFAULT_TTL_MS = 5000;

function wtCacheDisabled(): boolean {
  return getEnv("PRX_WT_CACHE_DISABLE") === "1";
}

function wtCacheTtlMs(): number {
  const raw = getEnv("PRX_WT_CACHE_TTL_MS");
  if (!raw) return WT_CACHE_DEFAULT_TTL_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : WT_CACHE_DEFAULT_TTL_MS;
}

function wtCacheDir(): string {
  const base = getEnv("XDG_CACHE_HOME") || join(homeDir(), ".cache");
  return join(base, "prx", "wt-status");
}

function wtCacheKey(repoPath: string, runner: CommandRunner): string | null {
  let result: CommandResult;
  try {
    result = runner(
      ["git", "-C", repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { check: false },
    );
  } catch {
    return null;
  }
  if (result.status !== 0) return null;
  const commonDir = result.stdout.trim();
  if (!commonDir) return null;
  return createHash("sha256").update(commonDir).digest("hex").slice(0, 16);
}

function readWtCache<T>(file: string, ttlMs: number): T | null {
  if (wtCacheDisabled()) return null;
  try {
    const raw = readFileSync(file, "utf8");
    const entry = JSON.parse(raw) as WtCacheEntry<T>;
    if (entry.version !== WT_CACHE_VERSION) return null;
    if (typeof entry.writtenAt !== "number" || !Number.isFinite(entry.writtenAt)) return null;
    const ageMs = Date.now() - entry.writtenAt;
    if (ageMs < 0 || ageMs > ttlMs) return null;
    return entry.value;
  } catch {
    return null;
  }
}

function writeWtCacheAtomic<T>(file: string, value: T): void {
  if (wtCacheDisabled()) return;
  const entry: WtCacheEntry<T> = {
    version: WT_CACHE_VERSION,
    writtenAt: Date.now(),
    value,
  };
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(entry));
    renameSync(tmp, file);
  } catch {
    // best-effort; a stale or missing cache file simply forces a re-fetch.
  }
}

export function wtStatus(
  repoPath: string,
  includeGitDetails = true,
  runner: CommandRunner = defaultRunner,
): WtStatusResult {
  if (wtCacheDisabled()) {
    return computeWtStatus(repoPath, includeGitDetails, runner);
  }

  const cacheKey = wtCacheKey(repoPath, runner);
  const cacheFile = cacheKey
    ? join(wtCacheDir(), `wt-${cacheKey}-${includeGitDetails ? "full" : "lite"}.json`)
    : null;
  if (cacheFile) {
    const cached = readWtCache<WtStatusResult>(cacheFile, wtCacheTtlMs());
    if (cached) return cached;
  }

  const result = computeWtStatus(repoPath, includeGitDetails, runner);
  if (cacheFile) writeWtCacheAtomic(cacheFile, result);
  return result;
}

/**
 * Project a single `git worktree list --porcelain` entry (plus its already-
 * computed `git status` enrichment) onto the `WtState` shape that
 * `normalizeWtState` consumes. This replaces the JSON that `wt list` used to
 * emit: prx now owns the git-worktree read directly via `@bounded-systems/git`, so the
 * external worktrunk binary is no longer on the board-read path.
 *
 * `main_state`, `symbols`, and `mismatch` are cosmetic (the board column logic
 * keys off `branch`/`git`/`mismatch` only — see localStatusForUnit). We derive
 * a faithful-enough `main_state`/`symbols` from the git status and drop wt's
 * dir↔branch mismatch heuristic: git porcelain reports the real checked-out
 * branch, and prx owns the worktree-path mapping, so there is no separate
 * expectation to disagree with.
 */
function synthesizeWtState(
  entry: ListedWorktree,
  git: WorktreeStatus | null,
  isPrimary: boolean,
): WtState {
  const ahead = git?.branch.ahead ?? 0;
  const behind = git?.branch.behind ?? 0;
  const counts = git?.counts;

  const symbols: string[] = [];
  if (counts && (counts.staged > 0 || counts.unstaged > 0)) symbols.push("!");
  if (counts && counts.untracked > 0) symbols.push("?");
  if (ahead > 0 && behind > 0) symbols.push("↕");
  else if (ahead > 0) symbols.push("↑");
  else if (behind > 0) symbols.push("↓");

  return {
    branch: entry.branch,
    path: entry.path,
    main_state: isPrimary ? "is_main" : "feature",
    ...(entry.head ? { commit: { sha: entry.head } } : {}),
    working_tree: counts
      ? {
          staged: counts.staged > 0,
          modified: counts.unstaged > 0,
          untracked: counts.untracked > 0,
          deleted: false,
          renamed: false,
        }
      : {},
    worktree: { detached: entry.detached, state: [] },
    remote: { ahead, behind },
    symbols,
  };
}

function computeWtStatus(
  repoPath: string,
  includeGitDetails: boolean,
  runner: CommandRunner,
): WtStatusResult {
  const root = repoRoot(repoPath, runner);
  let entries: ListedWorktree[];
  try {
    entries = listWorktrees(root, runner);
  } catch {
    return {
      source: "wt+git",
      wt_available: false,
      symbols: wtSymbolLegend,
      worktrees: [],
    };
  }

  const worktrees = entries.map((entry) => {
    let git: WorktreeStatus | null = null;
    if (includeGitDetails) {
      try {
        git = worktreeStatus(entry.path, runner);
      } catch {
        git = null;
      }
    }
    const normalized = normalizeWtState(synthesizeWtState(entry, git, entry.path === root));
    return { ...normalized, git };
  });

  return {
    source: "wt+git",
    wt_available: true,
    symbols: wtSymbolLegend,
    worktrees,
  };
}

function parseFetchDryRun(lines: string[]): RemoteStatus {
  const updates: string[] = [];
  const newRefs: string[] = [];
  const deletedRefs: string[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.includes("[new branch]")) {
      const match = line.match(/->\s*(\S+)$/);
      const ref = match?.[1];
      if (ref) newRefs.push(ref);
      continue;
    }
    if (line.includes("[deleted]")) {
      const match = line.match(/->\s*(\S+)$/);
      const ref = match?.[1];
      if (ref) deletedRefs.push(ref);
      continue;
    }
    if (line.includes("->")) {
      const parts = line.split("->");
      const ref = parts[1]?.trim();
      if (ref) updates.push(ref);
    }
  }

  const hasChanges = updates.length > 0 || newRefs.length > 0 || deletedRefs.length > 0;

  return {
    freshness: hasChanges ? "stale" : "fresh",
    fetch_required: hasChanges,
    fetch_status: hasChanges ? "ok" : "no-op",
    updated_refs: updates,
    new_refs: newRefs,
    deleted_refs: deletedRefs,
    raw: lines,
  };
}

function detectOperation(
  repoPath: string,
  runner: CommandRunner = defaultRunner,
): RepoStatusResult["operation"] {
  // `git --git-path` returns a REPO-relative path; resolve it against repoPath,
  // not the process CWD (which `existsSync` would otherwise use). Without this,
  // a caller whose own CWD is a repo mid-merge/rebase — e.g. a merge-queue
  // `gh-readonly-queue/...` checkout — false-positives on `.git/MERGE_HEAD` and
  // reports `operation: "merge"` for an unrelated repo. `resolve` leaves an
  // already-absolute git-path untouched.
  const gitOpExists = (name: string): boolean => {
    const p = tryPath(["git", "-C", repoPath, "rev-parse", "--git-path", name], runner);
    return p != null && existsSync(resolve(repoPath, p));
  };

  if (gitOpExists("MERGE_HEAD")) return "merge";
  if (gitOpExists("rebase-apply") || gitOpExists("rebase-merge")) return "rebase";
  if (gitOpExists("CHERRY_PICK_HEAD")) return "cherry-pick";
  return "none";
}

function tryPath(cmd: string[], runner: CommandRunner): string | null {
  const result = runner(cmd, { check: false });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function remoteStatus(repoPath: string, runner: CommandRunner = defaultRunner): RemoteStatus {
  if (wtCacheDisabled()) {
    return computeRemoteStatus(repoPath, runner);
  }

  const cacheKey = wtCacheKey(repoPath, runner);
  const cacheFile = cacheKey ? join(wtCacheDir(), `remote-${cacheKey}.json`) : null;
  if (cacheFile) {
    const cached = readWtCache<RemoteStatus>(cacheFile, wtCacheTtlMs());
    if (cached) return cached;
  }

  const status = computeRemoteStatus(repoPath, runner);
  if (cacheFile) writeWtCacheAtomic(cacheFile, status);
  return status;
}

function computeRemoteStatus(repoPath: string, runner: CommandRunner): RemoteStatus {
  const result = runner(["git", "-C", repoPath, "fetch", "--dry-run", "origin"], { check: false });
  const combined = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (result.status !== 0) {
    return {
      freshness: "unknown",
      fetch_required: false,
      fetch_status: "error",
      updated_refs: [],
      new_refs: [],
      deleted_refs: [],
      raw: combined,
    };
  }

  return parseFetchDryRun(combined);
}

export function repoStatus(
  repoPath: string,
  options: { includeGitDetails?: boolean; fetch?: boolean } = {},
  runner: CommandRunner = defaultRunner,
): RepoStatusResult {
  const root = repoRoot(repoPath, runner);
  if (options.fetch) {
    runner(["git", "-C", root, "fetch", "origin"], { check: false });
  }
  const local = worktreeStatus(root, runner);
  const worktrees = wtStatus(root, options.includeGitDetails ?? true, runner);
  const remote = remoteStatus(root, runner);
  const operation = detectOperation(root, runner);
  const currentPr = maybeViewCurrentPr(root, runner);

  return {
    source: "wt+git+gh",
    repo_root: root,
    operation,
    local,
    worktrees,
    remote,
    pr: currentPr
      ? {
          exists: true,
          number: currentPr.number,
          title: currentPr.title ?? null,
          url: currentPr.url ?? null,
          draft: currentPr.isDraft,
          checks: summarizeChecks(currentPr.statusCheckRollup),
          review: summarizeReview(currentPr.reviewDecision),
          approvals: countApprovals(currentPr.reviews),
          mergeable: summarizeMergeable(currentPr.mergeable),
        }
      : {
          exists: false,
          number: null,
          title: null,
          url: null,
          draft: null,
          checks: null,
          review: null,
          approvals: null,
          mergeable: null,
        },
  };
}

function inferTicket(branch: string): string | null {
  return canonicalWorkUnitIdFromBranchName(branch);
}

function deriveBoardColumn(
  unit: Omit<BoardUnit, "column" | "reasons">,
  remoteFreshness: RemoteFreshness,
): { column: BoardColumn; reasons: string[] } {
  const reasons: string[] = [];

  if (!unit.artifacts.worktree) {
    reasons.push("missing worktree");
    return { column: "no_worktree", reasons };
  }

  if (!unit.artifacts.branch) {
    reasons.push("missing branch");
    return { column: "worktree_created", reasons };
  }

  if (!unit.pr.exists) {
    if (
      (unit.local.staged ?? 0) > 0 ||
      (unit.local.unstaged ?? 0) > 0 ||
      (unit.local.untracked ?? 0) > 0
    ) {
      reasons.push("local changes before push");
      return { column: "committing", reasons };
    }
    reasons.push("branch pushed without open PR");
    return { column: "pushed", reasons };
  }

  if (unit.pr.draft) {
    reasons.push("PR is draft");
    return { column: "pr_open", reasons };
  }

  if (unit.pr.checks === "pending") {
    reasons.push("CI checks pending");
    return { column: "ci_running", reasons };
  }

  if (unit.pr.review === "changes_requested") {
    reasons.push("changes requested by reviewer");
    return { column: "changes_requested", reasons };
  }

  if (
    unit.pr.review === "approved" &&
    unit.pr.checks === "green" &&
    unit.pr.mergeable === "mergeable" &&
    remoteFreshness === "fresh"
  ) {
    reasons.push("approved + checks green + mergeable + remote fresh");
    return { column: "merge_ready", reasons };
  }

  if (unit.pr.review === "approved") {
    reasons.push("approved but merge gate incomplete");
    return { column: "approved", reasons };
  }

  reasons.push("PR in active review");
  return { column: "review", reasons };
}

export function boardStatus(repoPath: string, runner?: CommandRunner): BoardStatusResult;
export function boardStatus(
  repoPath: string,
  options: BoardStatusOptions,
  runner?: CommandRunner,
): BoardStatusResult;
export function boardStatus(
  repoPath: string,
  optionsOrRunner: BoardStatusOptions | CommandRunner = {},
  runner: CommandRunner = defaultRunner,
): BoardStatusResult {
  const options = typeof optionsOrRunner === "function" ? {} : optionsOrRunner;
  const effectiveRunner = typeof optionsOrRunner === "function" ? optionsOrRunner : runner;
  // GH-2306: when a concrete `targetBranch` is supplied, only the unit whose
  // branch normalizes to it gets remote/local hydration; the predicate mirrors
  // the canonical-id match the lone caller (`checkWorkUnitChain`) uses to pick
  // the unit, so the hydrated unit is exactly the one that caller reads. Absent
  // a target, every unit is eligible — the existing full-board behavior.
  const targetBranch = options.targetBranch;
  const matchesTarget = (branch: string): boolean =>
    targetBranch === undefined ||
    normalizeCanonicalWorkUnitId(branch) === normalizeCanonicalWorkUnitId(targetBranch);
  const root = repoRoot(repoPath, effectiveRunner);
  const parityConfig = loadSurfaceSyncConfig(root, effectiveRunner);
  const repo = repoNameWithOwner(root, effectiveRunner);
  const worktrees = wtStatus(root, true, effectiveRunner);
  const prs = listRepoOpenPrs(repo, effectiveRunner);
  const remote = remoteStatus(root, effectiveRunner);

  const prByBranch = new Map<string, OpenPr>();
  for (const pr of prs) {
    prByBranch.set(pr.headRefName, pr);
  }

  const units: BoardUnit[] = worktrees.wt_available
    ? worktrees.worktrees.map((wt) => {
        const pr = prByBranch.get(wt.branch);
        const base: Omit<BoardUnit, "column" | "reasons"> = {
          ticket: inferTicket(wt.branch),
          beadId: maybeLoadTaskBeadId(wt.path),
          branch: wt.branch,
          worktree_path: wt.path,
          pr: pr
            ? {
                exists: true,
                number: pr.number,
                title: pr.title ?? null,
                url: pr.url ?? null,
                draft: pr.isDraft,
                checks: summarizeChecks(pr.statusCheckRollup),
                review: summarizeReview(pr.reviewDecision),
                approvals: countApprovals(pr.reviews),
                mergeable: summarizeMergeable(pr.mergeable),
              }
            : {
                exists: false,
                number: null,
                title: null,
                url: null,
                draft: null,
                checks: null,
                review: null,
                approvals: null,
                mergeable: null,
              },
          artifacts: {
            worktree: true,
            branch: wt.branch.length > 0,
            pr: Boolean(pr),
            ticket: inferTicket(wt.branch) !== null,
          },
          local: {
            clean: wt.git?.clean ?? null,
            staged: wt.git?.counts.staged ?? null,
            unstaged: wt.git?.counts.unstaged ?? null,
            untracked: wt.git?.counts.untracked ?? null,
            conflicts: wt.git?.counts.conflicts ?? null,
          },
        };
        const derived = deriveBoardColumn(base, remote.freshness);
        return {
          ...base,
          status:
            options.remote && matchesTarget(wt.branch)
              ? {
                  remote: remoteStatusForUnit(
                    root,
                    repo,
                    wt.branch,
                    base.ticket,
                    base.beadId ?? null,
                    base.pr,
                    parityConfig,
                    effectiveRunner,
                  ),
                  local: localStatusForUnit(
                    root,
                    wt.branch,
                    base,
                    wt.structural.mismatch,
                    effectiveRunner,
                  ),
                }
              : undefined,
          column: derived.column,
          reasons: derived.reasons,
        };
      })
    : [];

  if (options.remote) {
    const localBranches = new Set(units.map((unit) => unit.branch));
    const remoteBranches = new Set(listRemoteBranches(root, effectiveRunner));
    for (const pr of prs) {
      if (localBranches.has(pr.headRefName)) {
        continue;
      }

      const base: Omit<BoardUnit, "column" | "reasons"> = {
        ticket: inferTicket(pr.headRefName),
        beadId: null,
        branch: pr.headRefName,
        worktree_path: null,
        pr: {
          exists: true,
          number: pr.number,
          title: pr.title ?? null,
          url: pr.url ?? null,
          draft: pr.isDraft,
          checks: summarizeChecks(pr.statusCheckRollup),
          review: summarizeReview(pr.reviewDecision),
          approvals: countApprovals(pr.reviews),
          mergeable: summarizeMergeable(pr.mergeable),
        },
        artifacts: {
          worktree: false,
          branch: pr.headRefName.length > 0,
          pr: true,
          ticket: inferTicket(pr.headRefName) !== null,
        },
        local: {
          clean: null,
          staged: null,
          unstaged: null,
          untracked: null,
          conflicts: null,
        },
      };
      const derived = deriveBoardColumn(base, remote.freshness);
      units.push({
        ...base,
        status: matchesTarget(pr.headRefName)
          ? {
              remote: remoteStatusForUnit(
                root,
                repo,
                pr.headRefName,
                base.ticket,
                base.beadId ?? null,
                base.pr,
                parityConfig,
                effectiveRunner,
              ),
              local: localStatusForUnit(root, pr.headRefName, base, false, effectiveRunner),
            }
          : undefined,
        column: derived.column,
        reasons: derived.reasons,
      });
    }

    for (const remoteBranch of remoteBranches) {
      if (
        localBranches.has(remoteBranch) ||
        prByBranch.has(remoteBranch) ||
        remoteBranch === "main" ||
        remoteBranch.length === 0
      ) {
        continue;
      }

      const base: Omit<BoardUnit, "column" | "reasons"> = {
        ticket: inferTicket(remoteBranch),
        beadId: null,
        branch: remoteBranch,
        worktree_path: null,
        pr: {
          exists: false,
          number: null,
          title: null,
          url: null,
          draft: null,
          checks: null,
          review: null,
          approvals: null,
          mergeable: null,
        },
        artifacts: {
          worktree: false,
          branch: true,
          pr: false,
          ticket: true,
        },
        local: {
          clean: null,
          staged: null,
          unstaged: null,
          untracked: null,
          conflicts: null,
        },
      };
      const derived = deriveBoardColumn(base, remote.freshness);
      units.push({
        ...base,
        status: matchesTarget(remoteBranch)
          ? {
              remote: remoteStatusForUnit(
                root,
                repo,
                remoteBranch,
                base.ticket,
                base.beadId ?? null,
                base.pr,
                parityConfig,
                effectiveRunner,
              ),
              local: localStatusForUnit(root, remoteBranch, base, false, effectiveRunner),
            }
          : undefined,
        column: derived.column,
        reasons: derived.reasons,
      });
    }

    // Pass 4: local-only branches — no worktree, no open PR, no remote branch.
    // These are orphaned branches from completed lifecycles (merged PR, deleted remote).
    const coveredBranches = new Set(units.map((unit) => unit.branch));
    const allLocalBranches = listLocalBranches(root, effectiveRunner);
    const remoteBranchSet = remoteBranches;
    for (const localBranch of allLocalBranches) {
      if (coveredBranches.has(localBranch) || localBranch === "main" || localBranch.length === 0) {
        continue;
      }

      const base: Omit<BoardUnit, "column" | "reasons"> = {
        ticket: inferTicket(localBranch),
        beadId: null,
        branch: localBranch,
        worktree_path: null,
        pr: {
          exists: false,
          number: null,
          title: null,
          url: null,
          draft: null,
          checks: null,
          review: null,
          approvals: null,
          mergeable: null,
        },
        artifacts: {
          worktree: false,
          branch: true,
          pr: false,
          ticket: inferTicket(localBranch) !== null,
        },
        local: {
          clean: null,
          staged: null,
          unstaged: null,
          untracked: null,
          conflicts: null,
        },
      };
      // GH-2306: skip the remote probe for non-target units on the scoped
      // fast path. Without it the PR lifecycle is unknown, so the unit falls
      // through to the same "no_worktree" column an un-completed branch gets;
      // this only affects non-target rows the lone scoped caller never reads.
      const hydrate = matchesTarget(localBranch);
      const remoteStatus = hydrate
        ? remoteStatusForUnit(
            root,
            repo,
            localBranch,
            base.ticket,
            base.beadId ?? null,
            base.pr,
            parityConfig,
            effectiveRunner,
          )
        : null;
      const localStatus = hydrate
        ? localStatusForUnit(root, localBranch, base, false, effectiveRunner)
        : null;
      // Use PR lifecycle from remote status to derive column for orphaned branches
      const completedLifecycle = remoteStatus?.pr === "completed";
      const column: BoardColumn = completedLifecycle
        ? remoteBranchSet.has(localBranch)
          ? "merged"
          : "cleaned"
        : "no_worktree";
      const reasons: string[] = completedLifecycle
        ? ["orphaned local branch from completed PR lifecycle"]
        : ["local-only branch without worktree"];
      units.push({
        ...base,
        status:
          remoteStatus && localStatus
            ? {
                remote: remoteStatus,
                local: localStatus,
              }
            : undefined,
        column,
        reasons,
      });
    }
  }

  // GH-914: stamp HEAD authorship of `origin/<branch>` on every unit
  // whose branch exists on origin, regardless of which pass produced
  // the unit (worktree-anchored Pass 1, PR-anchored Pass 2, remote-only
  // Pass 3, or local-only Pass 4). The action enumerator uses this to
  // suppress `delete_remote_branch` for teammate-authored branches even
  // when a stray local worktree pulls the unit out of Pass 3.
  if (options.remote) {
    const operatorIdentity = getOperatorIdentity(root, effectiveRunner);
    const remoteAuthors = readRemoteBranchAuthors(root, effectiveRunner);
    for (const unit of units) {
      const author = remoteAuthors.get(unit.branch);
      if (author) {
        unit.remote_branch_author = {
          name: author.name,
          email: author.email,
          isOperator: compareOperatorIdentity(operatorIdentity, author),
        };
      }
    }
  }

  units.sort((a, b) => a.branch.localeCompare(b.branch));

  return {
    source: "derived-board",
    repo,
    remote_freshness: remote.freshness,
    units,
  };
}

function chainIdentityForUnit(unit: BoardUnit): { id: string; display_id: string } {
  return unit.ticket
    ? { id: unit.ticket, display_id: unit.ticket }
    : { id: unit.branch, display_id: "no-ticket" };
}

/**
 * GH-872: classify a unit's parity row using the same routing/feature
 * gating that `buildSurfaceSyncFromBoard` already does. Reads the
 * repo's prx.toml to figure out which issue authority owns the prefix
 * and whether the feature is enabled, so the disposition reflects the
 * actual decision boundary the operator configured.
 *
 * Returns undefined when `unit.status` is missing (no remote enrichment
 * → nothing to classify against).
 */
function dispositionForUnit(
  unit: BoardUnit,
  parityConfig?: SurfaceSyncConfig,
  routingConfig?: PrefixRoutingConfig,
): Disposition | undefined {
  const status = unit.status;
  if (!status) return undefined;

  let issueFeatureEnabled = false;
  // Assigned on both branches below before it is read.
  let issueStatus: "clean" | "dirty" | "completed" | "disabled";
  if (parityConfig && routingConfig) {
    const issueFeature = issueFeatureForUnit(unit.branch, routingConfig);
    issueFeatureEnabled = issueFeature
      ? issueParityFeatureEnabled(parityConfig, issueFeature)
      : false;
    const raw = issueFeatureStatus(status, issueFeature);
    issueStatus = normalizeIssueStatus(raw, issueFeatureEnabled);
  } else {
    // Without config we can't know which authority routes — fall back to
    // gh_issue when present, treating disabled feature as authoritative-clean.
    issueStatus = normalizeIssueStatus(status.remote.gh_issue, true);
    issueFeatureEnabled = issueStatus !== "disabled";
  }

  return classify({
    status,
    local: unit.local,
    artifacts: unit.artifacts,
    issueFeatureEnabled,
    issueStatus,
  });
}

export function chainStatusFromBoard(
  board: BoardStatusResult,
  options: { repoPath?: string; runner?: CommandRunner } = {},
): ChainStatusResult {
  const parityConfig = options.repoPath
    ? loadSurfaceSyncConfig(options.repoPath, options.runner ?? defaultRunner)
    : undefined;
  const routingConfig = options.repoPath
    ? loadPrefixRoutingConfig(options.repoPath, options.runner ?? defaultRunner)
    : undefined;
  const rows = board.units.map((unit) => {
    const identity = chainIdentityForUnit(unit);
    return {
      ...identity,
      branch: unit.branch,
      ticket: unit.ticket,
      worktree_path: unit.worktree_path,
      pr: unit.pr,
      local: unit.local,
      status: unit.status,
      state: unit.column,
      ...(unit.status
        ? { disposition: dispositionForUnit(unit, parityConfig, routingConfig) }
        : {}),
      reasons: unit.reasons,
    } satisfies ChainStatusRow;
  });

  rows.sort((left, right) => {
    if (left.display_id === right.display_id) {
      return left.branch.localeCompare(right.branch);
    }
    if (left.display_id === "no-ticket") {
      return 1;
    }
    if (right.display_id === "no-ticket") {
      return -1;
    }
    return left.display_id.localeCompare(right.display_id);
  });

  return {
    source: "chains",
    repo: board.repo,
    remote_freshness: board.remote_freshness,
    rows,
  };
}

export function chainStatus(repoPath: string, runner?: CommandRunner): ChainStatusResult;
export function chainStatus(
  repoPath: string,
  options: BoardStatusOptions,
  runner?: CommandRunner,
): ChainStatusResult;
export function chainStatus(
  repoPath: string,
  optionsOrRunner: BoardStatusOptions | CommandRunner = {},
  runner: CommandRunner = defaultRunner,
): ChainStatusResult {
  const effectiveRunner = typeof optionsOrRunner === "function" ? optionsOrRunner : runner;
  const board =
    typeof optionsOrRunner === "function"
      ? boardStatus(repoPath, optionsOrRunner)
      : boardStatus(repoPath, optionsOrRunner, runner);
  return chainStatusFromBoard(board, { repoPath, runner: effectiveRunner });
}

// Columns where a unit has artifacts to clean up (worktree or branch present)
// AND the unit is still presented as forward progress — i.e., the surface
// would recommend `prx session open` or similar. If the backing issue is
// closed or the PR is merged, these become orphans and should reroute to
// `cleanup_pending`. Terminal columns (`merged`, `cleaned`) already encode
// lifecycle completion and are left alone.
const CLEANUP_ELIGIBLE_COLUMNS: ReadonlySet<BoardColumn> = new Set<BoardColumn>([
  "committing",
  "pushed",
  "pr_open",
  "ci_running",
  "review",
  "changes_requested",
  "approved",
  "merge_ready",
]);

function unitHasTerminalAuthority(
  repo: string,
  unit: BoardUnit,
  runner: CommandRunner,
): { terminal: boolean; reason: string | null } {
  if (!unit.ticket) {
    return { terminal: false, reason: null };
  }

  hydrateIssue(repo, unit.ticket, runner);
  const issue = maybeViewIssue(repo, unit.ticket);
  const issueLabel = issueLifecycleLabel(issue, unit.ticket);
  if (issueLabel === "completed") {
    const issueNumber = unit.ticket.match(/-(\d+)$/)?.[1];
    return {
      terminal: true,
      reason: issueNumber
        ? `GH issue #${issueNumber} closed — orphaned artifacts`
        : "linked GH issue closed — orphaned artifacts",
    };
  }

  // If the backing issue is open (`dirty`) or we can't resolve its state
  // (`unknown`), the branch may be carrying follow-up work — a rebase onto
  // main, a Copilot-review fix commit, etc. A merged PR alone is not enough
  // to call the worktree orphaned. GH-755: sweeping an open-issue worktree
  // whose earlier PR merged would discard in-flight follow-up work.
  return { terminal: false, reason: null };
}

// Probe-eligible shape: canonical work-unit branches (ticket != null,
// branch == ticket) are the only units that can be reclassified into
// `cleanup_pending`. Non-canonical branches and remote-only rows stay on
// their structural column — probing them would cost a `gh issue view` per
// unit for no user-visible change.
function isProbeEligible(unit: BoardUnit): boolean {
  if (!CLEANUP_ELIGIBLE_COLUMNS.has(unit.column)) {
    return false;
  }
  if (!unit.artifacts.worktree && !unit.artifacts.branch) {
    return false;
  }
  if (unit.ticket === null || unit.branch !== unit.ticket) {
    return false;
  }
  return true;
}

export function applyAuthorityOverrides(
  repo: string,
  units: BoardUnit[],
  runner: CommandRunner,
): BoardUnit[] {
  return units.map((unit) => {
    if (!isProbeEligible(unit)) {
      return unit;
    }
    const authority = unitHasTerminalAuthority(repo, unit, runner);
    if (!authority.terminal) {
      return unit;
    }
    return {
      ...unit,
      column: "cleanup_pending" as const,
      reasons: [...unit.reasons, authority.reason ?? "terminal authority detected"],
    };
  });
}

export function buildSurfaceSyncFromBoard(
  repoPath: string,
  board: BoardStatusResult,
  options: {
    mode?: SurfaceSyncMode;
    authority?: SurfaceSyncAuthority;
    scope?: SurfaceSyncScope;
    apply?: boolean;
    ticket?: string;
    /**
     * GH-1125: when true, filter to units whose PR is merged but whose
     * issue is still open and prepend a `close_issue` action. Strictly
     * additive — non-matching units emit no actions, matching units still
     * receive the standard prune-mode emit logic so `delete_remote_branch`
     * fires alongside the close.
     */
    mergedOnly?: boolean;
  } = {},
  runner: CommandRunner = defaultRunner,
): SurfaceSyncResult {
  const mode = options.mode ?? "full";
  const authority = options.authority ?? "issue";
  const scope = options.scope ?? "all";
  const apply = options.apply ?? false;
  const mergedOnly = options.mergedOnly ?? false;
  const ticketFilter = options.ticket ? normalizeCanonicalWorkUnitId(options.ticket) : undefined;
  const parityConfig = loadSurfaceSyncConfig(repoPath, runner);
  const routingConfig = loadPrefixRoutingConfig(repoPath, runner);

  return computeSurfaceSync({
    board,
    resolveBufferPath: () => resolveBufferRepoPath(repoPath, runner),
    mode,
    authority,
    scope,
    apply,
    mergedOnly,
    ticketFilter,
    parityConfig,
    routingConfig,
  });
}

export function buildParityChain(
  repoPath: string,
  options: {
    mode?: SurfaceSyncMode;
    authority?: SurfaceSyncAuthority;
    scope?: SurfaceSyncScope;
    apply?: boolean;
    ticket?: string;
    mergedOnly?: boolean;
  } = {},
  runner: CommandRunner = defaultRunner,
): SurfaceSyncResult {
  const board = boardStatus(repoPath, { remote: true }, runner);
  return buildSurfaceSyncFromBoard(repoPath, board, options, runner);
}

function diffStatsForPr(
  repo: string,
  prNumber: number,
  runner: CommandRunner,
): { files: number; additions: number; deletions: number } {
  const namesResult = runner(["gh", "pr", "diff", String(prNumber), "--name-only", "-R", repo], {
    check: false,
  });
  const diffResult = runner(
    ["gh", "pr", "diff", String(prNumber), "--color", "never", "-R", repo],
    { check: false },
  );

  const files =
    namesResult.status === 0
      ? namesResult.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean).length
      : 0;

  let additions = 0;
  let deletions = 0;

  if (diffResult.status === 0) {
    for (const rawLine of diffResult.stdout.split(/\r?\n/)) {
      if (!rawLine || rawLine.startsWith("+++ ") || rawLine.startsWith("--- ")) {
        continue;
      }
      if (rawLine.startsWith("+")) {
        additions += 1;
      } else if (rawLine.startsWith("-")) {
        deletions += 1;
      }
    }
  }

  return { files, additions, deletions };
}

function summarizeChecks(
  rollup:
    | Array<{ status?: string | null; conclusion?: string | null }>
    | {
        state?: string | null;
        contexts?: Array<{ status?: string | null; conclusion?: string | null }> | null;
      }
    | null
    | undefined,
): "green" | "pending" | "red" | "unknown" {
  if (!rollup) {
    return "unknown";
  }

  if (!Array.isArray(rollup)) {
    const state = (rollup.state ?? "").toUpperCase();
    if (state === "SUCCESS") return "green";
    if (state === "FAILURE") return "red";
    if (state === "PENDING") return "pending";
    return summarizeChecks(rollup.contexts ?? null);
  }

  if (rollup.length === 0) {
    return "unknown";
  }

  let sawPending = false;
  let sawCompleted = false;

  for (const item of rollup) {
    const status = (item.status ?? "").toUpperCase();
    const conclusion = (item.conclusion ?? "").toUpperCase();

    if (status === "PENDING" || status === "IN_PROGRESS" || status === "QUEUED" || !status) {
      sawPending = true;
      continue;
    }

    if (status === "COMPLETED") {
      sawCompleted = true;
      if (
        conclusion === "FAILURE" ||
        conclusion === "TIMED_OUT" ||
        conclusion === "CANCELLED" ||
        conclusion === "STARTUP_FAILURE" ||
        conclusion === "ACTION_REQUIRED"
      ) {
        return "red";
      }
      if (
        conclusion === "" ||
        conclusion === "NEUTRAL" ||
        conclusion === "SKIPPED" ||
        conclusion === "STALE"
      ) {
        continue;
      }
    }
  }

  if (sawPending) {
    return "pending";
  }
  if (sawCompleted) {
    return "green";
  }
  return "unknown";
}

function summarizeMergeable(mergeable: string | null | undefined): OverviewRow["mergeable"] {
  const normalized = (mergeable ?? "").toUpperCase();
  if (normalized === "MERGEABLE") {
    return "mergeable";
  }
  if (normalized === "CONFLICTING") {
    return "conflicting";
  }
  return "unknown";
}

function countApprovals(
  reviews:
    | Array<{ state?: string | null }>
    | { nodes?: Array<{ state?: string | null }> | null }
    | null
    | undefined,
): number {
  const list = Array.isArray(reviews) ? reviews : (reviews?.nodes ?? []);
  return list.filter((review) => (review.state ?? "").toUpperCase() === "APPROVED").length;
}

function summarizeReview(decision: string | null | undefined): OverviewRow["review"] {
  const normalized = (decision ?? "").toUpperCase();
  if (normalized === "APPROVED") {
    return "approved";
  }
  if (normalized === "CHANGES_REQUESTED") {
    return "changes_requested";
  }
  if (normalized === "REVIEW_REQUIRED") {
    return "review_required";
  }
  if (normalized === "COMMENTED") {
    return "commented";
  }
  return "unknown";
}

function enrichOverviewRow(
  pr: {
    number: number;
    title?: string;
    headRefName?: string;
    isDraft: boolean;
    url?: string;
    reviewDecision?: string | null;
    statusCheckRollup?:
      | Array<{ status?: string | null; conclusion?: string | null }>
      | {
          state?: string | null;
          contexts?: Array<{ status?: string | null; conclusion?: string | null }> | null;
        }
      | null;
    mergeable?: string | null;
    reviews?:
      | Array<{ state?: string | null }>
      | { nodes?: Array<{ state?: string | null }> | null }
      | null;
  },
  branchToWorktree: Record<string, string>,
  repo: string,
  includeDiffStats: boolean,
  runner: CommandRunner,
): OverviewRow {
  const branch = pr.headRefName ?? "";
  const worktreePath = branchToWorktree[branch];
  let local: OverviewRow["local"] = null;
  let worktree: OverviewRow["worktree"] = null;
  const diff = includeDiffStats ? diffStatsForPr(repo, pr.number, runner) : null;

  if (worktreePath) {
    try {
      const summary = worktreeStatus(worktreePath, runner);
      worktree = {
        clean: summary.clean,
        staged: summary.counts.staged,
        unstaged: summary.counts.unstaged,
        untracked: summary.counts.untracked,
        conflicts: summary.counts.conflicts,
      };
    } catch {
      worktree = null;
    }

    const { contract, contractPath } = loadContractForBranch(worktreePath);
    if (contract) {
      const info = deriveInfo(contract);
      local = {
        worktreePath,
        contractPath,
        lifecycle: info.state,
        mode: info.mode,
      };
    }
  }

  return {
    number: pr.number,
    title: pr.title ?? "",
    branch,
    url: pr.url ?? "",
    draft: pr.isDraft,
    checks: summarizeChecks(pr.statusCheckRollup),
    review: summarizeReview(pr.reviewDecision),
    approvals: countApprovals(pr.reviews),
    mergeable: summarizeMergeable(pr.mergeable),
    worktree,
    diff,
    local,
  };
}

export function overviewStatus(
  repoPath: string,
  includeDiffStats = true,
  runner: CommandRunner = defaultRunner,
): OverviewResult {
  const root = repoRoot(repoPath, runner);
  const repo = repoNameWithOwner(root, runner);
  const branchToWorktree = worktreeMap(root, runner);
  const createdByYou = listOpenPrs(repo, runner).map((pr) =>
    enrichOverviewRow(pr, branchToWorktree, repo, includeDiffStats, runner),
  );
  const currentBranchPr = maybeViewCurrentPr(repoPath, runner);

  return {
    repo,
    currentBranch: currentBranchPr
      ? enrichOverviewRow(currentBranchPr, branchToWorktree, repo, includeDiffStats, runner)
      : null,
    createdByYou,
  };
}

export type UpdatePrResult = {
  exitCode: number;
  lines: string[];
};

export function updatePrFromContract(
  repoPath: string,
  contractPath: string,
  outputPath: string,
  prRef: string | undefined,
  apply: boolean,
  runner: CommandRunner = defaultRunner,
  renderRunner: RenderRunner = defaultRenderRunner,
): UpdatePrResult {
  const contract = loadContract(contractPath);
  const prContract = ensurePrState(contract);
  const info = deriveInfo(contract);
  const currentPr = viewPr(repoPath, prRef, runner);
  const resolvedPrRef = String(currentPr.number);
  const lines: string[] = [];

  if (!apply) {
    lines.push(`WOULD RENDER ${contractPath} -> ${outputPath}`);
    lines.push(`WOULD UPDATE PR #${resolvedPrRef} title/body from contract`);
    if (info.mode === "ready" && currentPr.isDraft) {
      lines.push(`WOULD MARK PR #${resolvedPrRef} ready for review`);
    } else if (info.mode === "draft" && !currentPr.isDraft) {
      lines.push(`WOULD MARK PR #${resolvedPrRef} draft`);
    } else {
      lines.push(`WOULD KEEP PR #${resolvedPrRef} in ${info.mode} mode`);
    }
    return { exitCode: 0, lines };
  }

  renderRunner(contractPath, outputPath);
  lines.push(`UPDATED ${outputPath} from ${contractPath}`);

  runner(
    [
      "gh",
      "pr",
      "edit",
      resolvedPrRef,
      "--title",
      prContract.title ?? "",
      "--body-file",
      outputPath,
    ],
    { cwd: repoPath },
  );
  lines.push(`UPDATED PR #${resolvedPrRef} title/body from contract`);

  if (info.mode === "ready" && currentPr.isDraft) {
    runner(["gh", "pr", "ready", resolvedPrRef], { cwd: repoPath });
    lines.push(`UPDATED PR #${resolvedPrRef} draft -> ready`);
  } else if (info.mode === "draft" && !currentPr.isDraft) {
    runner(["gh", "pr", "ready", resolvedPrRef, "--undo"], { cwd: repoPath });
    lines.push(`UPDATED PR #${resolvedPrRef} ready -> draft`);
  } else {
    lines.push(
      `OK PR #${resolvedPrRef}: current=${currentPr.isDraft ? "draft" : "ready"} desired=${info.mode}`,
    );
  }

  return { exitCode: 0, lines };
}

export function syncStatus(
  repoPath: string,
  apply: boolean,
  runner: CommandRunner = defaultRunner,
): { exitCode: number; lines: string[] } {
  const root = repoRoot(repoPath, runner);
  const repo = repoNameWithOwner(root, runner);
  const prs = listOpenPrs(repo, runner);
  const branchToWorktree = worktreeMap(root, runner);

  if (prs.length === 0) {
    return { exitCode: 0, lines: ["No open PRs found for @me."] };
  }

  const lines: string[] = [];
  let exitCode = 0;

  for (const pr of prs) {
    const branch = pr.headRefName;
    const worktree = branchToWorktree[branch];

    if (!worktree) {
      lines.push(`SKIP #${pr.number} ${branch}: no local worktree for branch`);
      continue;
    }

    const { contract, contractPath } = loadContractForBranch(worktree);
    if (!contract) {
      lines.push(`SKIP #${pr.number} ${branch}: missing contract at ${contractPath}`);
      continue;
    }

    const desiredMode = deriveInfo(contract).mode;
    const currentMode = currentModeForPr(pr);

    if (desiredMode === "draft" && currentMode !== "draft") {
      if (apply) {
        try {
          runner(["gh", "pr", "ready", String(pr.number), "--undo", "-R", repo]);
          lines.push(`UPDATED #${pr.number} ${branch}: ready -> draft`);
        } catch (error) {
          const message = error instanceof Error && error.message ? error.message : "Unknown error";
          lines.push(`FAIL #${pr.number} ${branch}: ${message}`);
          exitCode = 1;
        }
      } else {
        lines.push(`WOULD UPDATE #${pr.number} ${branch}: ready -> draft`);
      }
    } else {
      lines.push(`OK #${pr.number} ${branch}: current=${currentMode} desired=${desiredMode}`);
    }
  }

  return { exitCode, lines };
}

export async function syncGitHubIssuesToBeads(
  repoPath: string,
  apply: boolean,
  runner: CommandRunner = defaultRunner,
  // Beads retired (GH-1012): this positional seam used to inject the `execBd`
  // wrapper for the identity audit. It is kept as an unused, loosely-typed slot
  // so existing positional callers (which still pass a value here before
  // `beadsSync`) keep working; the audit no longer reads bd.
  _exec: unknown = undefined,
  // GH-2011 — canonical reconcile seam (replaces the legacy bd github sync
  // shell-out). Tests override this to assert chaining without spawning
  // real `gh` traffic; production callers use the default.
  beadsSync: typeof runBeadsSync = runBeadsSync,
): Promise<SyncGitHubIssuesToBeadsResult> {
  const root = repoRoot(repoPath, runner);
  const repo = repoNameWithOwner(root, runner);
  const lines: string[] = [];

  const configuredRepo = parseBeadsConfigValue(
    runner(["bd", "config", "get", "github.repository"], { cwd: root, check: false }).stdout,
  );

  if (configuredRepo !== repo) {
    if (apply) {
      const configResult = runner(["bd", "config", "set", "github.repository", repo], {
        cwd: root,
        check: false,
      });
      if (configResult.status !== 0) {
        const message =
          (configResult.stderr || configResult.stdout).trim() ||
          "Failed to configure beads GitHub repository";
        lines.push(`FAIL beads github.repository -> ${repo}: ${message}`);
        return { exitCode: 1, lines };
      }
      lines.push(`UPDATED beads github.repository -> ${repo}`);
    } else {
      lines.push(`WOULD UPDATE beads github.repository: ${configuredRepo || "unset"} -> ${repo}`);
    }
  } else {
    lines.push(`OK beads github.repository=${repo}`);
  }

  if (!apply && configuredRepo !== repo) {
    lines.push("WOULD RUN prx beads sync --domain=gh --dry-run after updating github.repository");
    return { exitCode: 0, lines };
  }

  // GH-2011: route through the canonical reconcile rather than the retired
  // bd-side reconcile shell-out.
  const syncCapture: { stdout: string[]; stderr: string[] } = { stdout: [], stderr: [] };
  const syncOutputSink = {
    log: (line: string) => syncCapture.stdout.push(line),
    error: (line: string) => syncCapture.stderr.push(line),
  };
  const syncResult = await beadsSync(
    {
      repo,
      domain: "gh",
      dryRun: !apply,
      limit: DEFAULT_SYNC_LIMIT,
      format: "plain",
    },
    syncOutputSink,
    { cwd: () => root },
  );
  const syncStdout = syncCapture.stdout.join("\n").trim();
  const syncStderr = syncCapture.stderr.join("\n").trim();
  if (syncResult.exitCode !== 0) {
    const detail = syncStderr || syncStdout;
    lines.push(detail ? `FAIL bd github sync: ${detail}` : "FAIL bd github sync");
    return { exitCode: 1, lines };
  }

  if (syncStdout) {
    lines.push(...syncStdout.split(/\r?\n/).filter((line) => line.trim().length > 0));
  } else {
    lines.push(apply ? "OK beads issue sync applied." : "OK beads issue sync dry-run completed.");
  }

  const identityResult = enforceGitHubIssueIdentity(root, repo, apply, runner);
  lines.push(...identityResult.lines);

  return { exitCode: identityResult.exitCode, lines };
}

function parseBeadsConfigValue(stdout: string): string {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return "";
  }

  try {
    const parsed = JSON.parse(trimmed) as { value?: unknown };
    if (typeof parsed?.value === "string") {
      return parsed.value;
    }
  } catch {
    // Fall back to legacy plain-text output from bd config get.
  }

  return trimmed;
}
