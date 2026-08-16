// GH-2262: `prx submit stage <work-unit-id>` — the PRODUCER half of the GH-1900
// submit pipeline. Resolves the current git state into a `SubmitArtifact`,
// writes the patch bytes + metadata into the `submit` CAS domain, and advances
// `<UoW>:submit@<slot>`. The downstream `prx submit publish --from-cas <ref>`
// consumes exactly the ref this writes.
//
// This closes the GH-1900 gap: the artifact schema (artifact.schema.ts) and the
// `publish` consumer (publish.ts) shipped, but nothing ever wrote a
// `submit@{draft,ready}` slot — `writeSubmitArtifact` had no production caller,
// so `prx submit session` had nothing to stage with.
//
// Git READS go through `@bounded-systems/git` `execGit`, the canonical
// (policy-aware) git seam — only `rev-parse`/`log`/`diff`, so staging never
// mutates via this path (prx-3f1 / #119 added `log`, for the merge base that
// resolves the patch base — see `resolveBaseCommit`). GH-2381: the artifact's identity is a git TREE SHA, not a
// committed HEAD, so a headless `prx implement` run (uncommitted edits, no
// commit) can still mint a durable artifact. The git-WRITE that materializes
// that tree (`add -A` + `write-tree`) is NOT run here — stage routes it to
// keeper (the sole git-writer, I-AUD4) via the injectable `materializeTree`
// seam, mirroring publish.ts's keeper/publisher delegation. The reads are
// injectable via `StageDeps.git` so tests run hermetically.

import { execGit } from "@bounded-systems/git";

import { runKeeperWriteTree } from "../pr-state/keeper.ts";
import { PlanStoreError, type CasSha } from "../plan-store/cas.ts";
import {
  submitRefFor,
  writeSubmitArtifact,
  writeSubmitPatchBlob,
  type SubmitArtifact,
  type SubmitSlot,
} from "./artifact.schema.ts";

export interface StageOptions {
  workUnitId: string;
  /** Target slot to advance. Defaults to `ready` at the CLI layer. */
  slot: SubmitSlot;
  /**
   * Base BRANCH the PR will target — a branch name (`main`), not a commit. The
   * commit the diff is actually taken against is derived from it by
   * {@link resolveBaseCommit}, which prefers the remote-tracking ref.
   */
  baseRef: string;
  /** PR summary; defaults to a synthetic `Submit <workUnitId>`. */
  summary?: string | undefined;
  dryRun: boolean;
  format: "plain" | "json";
  /** Repo dir; defaults to the process cwd via execGit. */
  cwd?: string | undefined;
}

export class StageError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "StageError";
    this.exitCode = exitCode;
  }
}

/**
 * The minimal git READ surface the producer needs — `rev-parse` (base commit +
 * base tree), `log` (the merge base, see {@link resolveBaseCommit}) and `diff`,
 * all inside `execGit`'s allowlist and all in the same read-only policy tier.
 * The git-WRITE that materializes the proposed tree lives on keeper, not here.
 * Injectable so tests need no real repository.
 */
export interface GitReader {
  revParse(ref: string, cwd?: string): string;
  /** `rev-parse` that reports an unresolvable rev as `null` instead of throwing. */
  tryRevParse(ref: string, cwd?: string): string | null;
  /** The remote-tracking ref a branch tracks (`main` → `origin/main`), or `null`. */
  upstreamOf(ref: string, cwd?: string): string | null;
  /** Merge base of two revs, or `null` when they share no history. */
  mergeBase(a: string, b: string, cwd?: string): string | null;
  diff(from: string, to: string, cwd?: string): string;
}

function gitOrThrow(subcommand: string, args: string[], cwd: string | undefined): string {
  const result = execGit({
    subcommand,
    args,
    ...(cwd === undefined ? {} : { cwd }),
  });
  if (result.exitCode !== 0) {
    throw new StageError(
      `prx submit stage: git ${subcommand} ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

/** Same call, but a non-zero exit is an ANSWER (`null`), not an error. */
function gitOrNull(subcommand: string, args: string[], cwd: string | undefined): string | null {
  const result = execGit({
    subcommand,
    args,
    ...(cwd === undefined ? {} : { cwd }),
  });
  if (result.exitCode !== 0) return null;
  const out = result.stdout.trim();
  return out === "" ? null : out;
}

// prx-3f1 / #119: `git merge-base` is NOT on `execGit`'s allowlist (that seam
// lives in `@bounded-systems/git`), so the merge base is read with `log`, which
// is — and is in the same read-only policy tier as the `diff`/`rev-parse` this
// producer already uses. `log --boundary A...B` walks the symmetric difference
// and marks the BOUNDARY commits, and the boundary of a symmetric difference is
// exactly the merge base(s); `%m` is the mark (`<` left, `>` right, `-`
// boundary). The classic `rev-list --boundary` idiom, spelled with the verb the
// allowlist admits. Criss-cross histories have several merge bases — take the
// first, which `log`'s reverse-chronological order makes the most recent, the
// same one `git merge-base` would pick.
function parseMergeBase(out: string | null): string | null {
  if (out === null) return null;
  for (const line of out.split("\n")) {
    if (!line.startsWith("- ")) continue;
    const sha = line.slice(2).trim();
    if (/^[0-9a-f]{40}$/.test(sha)) return sha;
  }
  return null;
}

export const defaultGitReader: GitReader = {
  revParse: (ref, cwd) => gitOrThrow("rev-parse", [ref], cwd).trim(),
  tryRevParse: (ref, cwd) => gitOrNull("rev-parse", ["--verify", "--quiet", ref], cwd),
  upstreamOf: (ref, cwd) => gitOrNull("rev-parse", ["--abbrev-ref", `${ref}@{upstream}`], cwd),
  mergeBase: (a, b, cwd) =>
    parseMergeBase(gitOrNull("log", ["--boundary", "--format=%m %H", `${a}...${b}`], cwd)),
  diff: (from, to, cwd) => gitOrThrow("diff", [from, to], cwd),
};

/** Where the base commit came from — reported so a stale base is visible. */
export interface ResolvedBase {
  /** The commit the patch is taken from, and keeper parents the commit on. */
  sha: string;
  /** The rev `sha` was resolved from — the remote-tracking ref when there is one. */
  resolvedFrom: string;
  /** How `sha` was derived from `resolvedFrom`. */
  via: "merge-base" | "tip";
}

/**
 * prx-3f1 / #119: resolve the base BRANCH to the commit the patch is taken
 * against. Naively this was `rev-parse <baseRef>` — the LOCAL `main` ref, which
 * lags `origin/main` during a long orchestration or whenever someone else
 * pushes. Diffing against a stale local `main` folds every intervening main
 * change into the unit's patch (observed: 76KB/34 files for a 10-file change).
 *
 * Two corrections, and BOTH are needed:
 *
 *  1. Prefer the REMOTE-TRACKING ref (`main@{upstream}`, else `origin/main`)
 *     over the local branch, since the local branch is the thing that goes
 *     stale.
 *  2. Take the MERGE BASE with `HEAD`, not the tip. The tip alone swaps one
 *     bug for its mirror image: a unit cut before `origin/main` advanced does
 *     not contain those commits, so diffing from the tip renders them as
 *     REVERTS in the patch. The merge base is the fork point — the one commit
 *     against which the diff is exactly the unit's own change.
 *
 * A pleasant consequence of (2): the merge base does not move when `origin/main`
 * gains commits on top, so the answer is insensitive to how recently the
 * remote-tracking ref was fetched. This producer therefore stays a pure READER
 * — no `fetch`, no ref mutation, keeper remains the sole git-writer (I-AUD4).
 *
 * Falls back to the tip of `resolvedFrom` when there is no `HEAD` (unborn
 * branch) or no common ancestor (unrelated histories), and to the local ref
 * when no remote-tracking ref exists at all (a repo with no `origin` — every
 * hermetic test repo, for one).
 */
export function resolveBaseCommit(
  baseRef: string,
  git: GitReader = defaultGitReader,
  cwd?: string,
): ResolvedBase {
  const resolvedFrom = remoteTrackingRef(baseRef, git, cwd) ?? baseRef;
  const head = git.tryRevParse("HEAD", cwd);
  if (head !== null) {
    const mergeBase = git.mergeBase(head, resolvedFrom, cwd);
    if (mergeBase !== null) return { sha: mergeBase, resolvedFrom, via: "merge-base" };
  }
  return { sha: git.revParse(resolvedFrom, cwd), resolvedFrom, via: "tip" };
}

/**
 * The remote-tracking ref for a base branch: what it actually tracks first (so
 * a fork's `upstream/main` wins over `origin/main`), then the `origin/` guess.
 * `null` when neither resolves — including when the caller already passed a
 * remote-tracking ref or a raw sha, which must not be `origin/`-prefixed twice.
 */
function remoteTrackingRef(
  baseRef: string,
  git: GitReader,
  cwd: string | undefined,
): string | null {
  const upstream = git.upstreamOf(baseRef, cwd);
  if (upstream !== null) return upstream;
  const guess = `origin/${baseRef}`;
  return git.tryRevParse(guess, cwd) === null ? null : guess;
}

export interface StageDeps {
  git?: GitReader;
  /**
   * Materialize the working state into a git tree SHA. Defaults to keeper's
   * `runKeeperWriteTree` (the sole git-writer); tests inject a fake.
   */
  materializeTree?: (cwd?: string) => Promise<string>;
  writeSubmitPatchBlob?: typeof writeSubmitPatchBlob;
  writeSubmitArtifact?: typeof writeSubmitArtifact;
  now?: () => Date;
}

export interface StageRender {
  workUnitId: string;
  slot: SubmitSlot;
  ref: string;
  /** Artifact metadata CAS sha — absent on a dry run (nothing is written). */
  sha?: CasSha;
  baseRef: string;
  baseSha: string;
  /** The rev `baseSha` was resolved from — `origin/main` rather than `main`. */
  baseResolvedFrom: string;
  /** How `baseSha` was derived from `baseResolvedFrom`. */
  baseVia: "merge-base" | "tip";
  /** The proposed git tree SHA — the artifact's deterministic identity. */
  tree: { sha: string };
  /** Patch CAS sha is absent on a dry run; byte count is always computed. */
  patch: { sha?: CasSha; bytes: number };
  summary: string;
  createdAt: string;
  dryRun: boolean;
  exitCode: number;
}

/**
 * Resolve git state → `SubmitArtifact`, persist it (patch blob + metadata) into
 * the submit CAS, and advance `<UoW>:submit@<slot>`. On `dryRun` nothing is
 * written: the resolved git state and target ref are reported so the operator
 * can confirm before staging.
 */
export async function runSubmitStage(
  opts: StageOptions,
  deps: StageDeps = {},
): Promise<StageRender> {
  const git = deps.git ?? defaultGitReader;
  const materializeTree = deps.materializeTree ?? ((cwd) => runKeeperWriteTree(cwd));
  const writePatch = deps.writeSubmitPatchBlob ?? writeSubmitPatchBlob;
  const writeArtifact = deps.writeSubmitArtifact ?? writeSubmitArtifact;
  const now = deps.now ?? (() => new Date());

  // Lineage parent (resolved base commit) + the base tree it points at. The
  // base tree is the no-op yardstick: an unchanged working state hashes to it.
  // prx-3f1 / #119: resolved from the remote-tracking ref's merge base, NOT the
  // local branch ref, which lags and bloats the patch — see resolveBaseCommit.
  const resolvedBase = resolveBaseCommit(opts.baseRef, git, opts.cwd);
  const baseSha = resolvedBase.sha;
  const baseTree = git.revParse(`${baseSha}^{tree}`, opts.cwd);

  // Keeper materializes the working state into a tree SHA (sole git-writer).
  const treeSha = await materializeTree(opts.cwd);

  if (treeSha === baseTree) {
    throw new StageError(
      `prx submit stage: working tree matches ${resolvedBase.resolvedFrom} (${baseSha.slice(0, 8)}) — nothing to submit.`,
    );
  }

  const patchText = git.diff(baseSha, treeSha, opts.cwd);
  const patchBytes = Buffer.byteLength(patchText, "utf8");

  const summarySource = opts.summary ?? `Submit ${opts.workUnitId}`;
  const summary = summarySource.slice(0, 500);
  const createdAt = now().toISOString();
  const ref = submitRefFor(opts.workUnitId, opts.slot);

  const base = {
    workUnitId: opts.workUnitId,
    slot: opts.slot,
    ref,
    baseRef: opts.baseRef,
    baseSha,
    baseResolvedFrom: resolvedBase.resolvedFrom,
    baseVia: resolvedBase.via,
    tree: { sha: treeSha },
    summary,
    createdAt,
  } as const;

  if (opts.dryRun) {
    return {
      ...base,
      patch: { bytes: patchBytes },
      dryRun: true,
      exitCode: 0,
    };
  }

  const { sha: patchSha, bytes } = await writePatch(patchText);
  const artifact: SubmitArtifact = {
    workUnitId: opts.workUnitId,
    baseRef: opts.baseRef,
    baseSha,
    tree: { sha: treeSha },
    patch: { sha: patchSha, bytes },
    summary,
    createdAt,
  };

  let result: { ref: string; sha: CasSha };
  try {
    result = await writeArtifact({ artifact, slot: opts.slot });
  } catch (err) {
    if (err instanceof PlanStoreError) {
      throw new StageError(`prx submit stage: failed to write artifact: ${err.message}`);
    }
    throw err;
  }

  return {
    ...base,
    sha: result.sha,
    patch: { sha: patchSha, bytes },
    dryRun: false,
    exitCode: 0,
  };
}

export function formatStageRender(render: StageRender, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(render, null, 2);
  }
  const lines: string[] = [];
  lines.push(
    `prx submit stage: ${render.dryRun ? "DRY RUN " : ""}${render.workUnitId} → ${render.ref}`,
  );
  lines.push(`  base: ${render.baseRef}@${render.baseSha}`);
  // prx-3f1 / #119: say WHICH rev the base came from. A base taken from the
  // local branch (no remote-tracking ref) is the stale-base failure mode this
  // line exists to make visible before the patch is staged, not after review.
  lines.push(
    render.baseResolvedFrom === render.baseRef
      ? `  base-from: ${render.baseRef} (${render.baseVia}; LOCAL ref — no remote-tracking branch, may be stale)`
      : `  base-from: ${render.baseResolvedFrom} (${render.baseVia})`,
  );
  lines.push(`  tree: ${render.tree.sha}`);
  lines.push(
    `  patch: ${render.patch.bytes} bytes${render.patch.sha ? ` (${render.patch.sha})` : ""}`,
  );
  lines.push(`  summary: ${render.summary}`);
  if (render.sha) {
    lines.push(`  artifact: ${render.sha}`);
    lines.push(`  next: prx submit publish --from-cas ${render.ref}`);
  } else {
    lines.push(`  (dry run — nothing written to the submit CAS)`);
  }
  return lines.join("\n");
}
