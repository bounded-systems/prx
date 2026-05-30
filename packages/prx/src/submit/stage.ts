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
// (policy-aware) git seam — only `rev-parse`/`diff`, so staging never mutates
// via this path. GH-2381: the artifact's identity is a git TREE SHA, not a
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
  /** Base branch the PR will target and the diff is taken against. */
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
 * base tree) and `diff`, both inside `execGit`'s allowlist. The git-WRITE that
 * materializes the proposed tree lives on keeper, not here. Injectable so tests
 * need no real repository.
 */
export interface GitReader {
  revParse(ref: string, cwd?: string): string;
  diff(from: string, to: string, cwd?: string): string;
}

function gitOrThrow(
  subcommand: string,
  args: string[],
  cwd: string | undefined,
): string {
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

const defaultGitReader: GitReader = {
  revParse: (ref, cwd) => gitOrThrow("rev-parse", [ref], cwd).trim(),
  diff: (from, to, cwd) => gitOrThrow("diff", [from, to], cwd),
};

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
  const materializeTree =
    deps.materializeTree ?? ((cwd) => runKeeperWriteTree(cwd));
  const writePatch = deps.writeSubmitPatchBlob ?? writeSubmitPatchBlob;
  const writeArtifact = deps.writeSubmitArtifact ?? writeSubmitArtifact;
  const now = deps.now ?? (() => new Date());

  // Lineage parent (resolved base commit) + the base tree it points at. The
  // base tree is the no-op yardstick: an unchanged working state hashes to it.
  const baseSha = git.revParse(opts.baseRef, opts.cwd);
  const baseTree = git.revParse(`${opts.baseRef}^{tree}`, opts.cwd);

  // Keeper materializes the working state into a tree SHA (sole git-writer).
  const treeSha = await materializeTree(opts.cwd);

  if (treeSha === baseTree) {
    throw new StageError(
      `prx submit stage: working tree matches ${opts.baseRef} (${baseTree.slice(0, 8)}) — nothing to submit.`,
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
      throw new StageError(
        `prx submit stage: failed to write artifact: ${err.message}`,
      );
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

export function formatStageRender(
  render: StageRender,
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(render, null, 2);
  }
  const lines: string[] = [];
  lines.push(
    `prx submit stage: ${render.dryRun ? "DRY RUN " : ""}${render.workUnitId} → ${render.ref}`,
  );
  lines.push(`  base: ${render.baseRef}@${render.baseSha}`);
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
