/**
 * Workspace actor implementation (GH-1978).
 *
 * Owns the workspace lifecycle:
 *
 *     reserved → prepared → ready ⇄ running → torn_down
 *
 * Drivers (`worktrunk` is the only driver today; devcontainer / nix
 * devShell / CI pre-job are future drivers) call into this module via
 * the `prx workspace <verb>` CLI surface. The module MUST NOT import
 * driver-specific code or branch on driver vocabulary — that contract
 * is enforced socially by I-WS1..I-WS4 (see `src/machine/state.ts`
 * `invariantSpecs`).
 *
 * Invariants (matching `invariantSpecs`):
 *   I-WS1  reserve is the only entry. prepare/sync/service/teardown
 *          against a workspace with no prior WORKSPACE_RESERVED fails
 *          closed (returns status='error' with a message saying so).
 *   I-WS2  tooling-file writes (sync/prepare) are atomic (tmp + rename).
 *   I-WS3  service start --auto with no profile is a no-op (skipped).
 *   I-WS4  every event carries workspace_id (the CLI thread is
 *          responsible for the uow_id pairing; this module only
 *          guarantees workspace_id).
 *   I-WS5  a gated mutation (prepare/sync/service/teardown) whose
 *          reserved ledger resolves worktree_path to the read-only
 *          `mainx` replica fails closed (status='error'), even under
 *          teardown --force. Defensive backstop that keeps the merged
 *          by-id ledger lookup (#2273) safe; read verbs are unaffected.
 *
 * The lifecycle ledger is persisted at
 * `<repoCommonDir>/info/workspace/<workspace_id>.json` so I-WS1 holds
 * across process boundaries. `reserve` writes the ledger; the other
 * verbs read it before acting.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnCapture } from "@bounded-systems/proc";

import { ensureBranch, type EnsureBranchResult } from "../tools/ensure_branch.ts";
import {
  expectedWorktreePath,
  WorktreeAddError,
  type WorktreeSpawn,
} from "../tools/worktree_layout.ts";
import { runKeeperEnsureWorktree, type KeeperEnsureWorktreeDeps } from "../pr-state/keeper.ts";
import { ensurePrxExcludes } from "../tools/ignore_sync.ts";
import { loadWorkspaceConfig, legacyGithubIdentitySegments } from "../pr-state/github.ts";
import { isMainxPath } from "../pr-state/scope-inference.ts";
import {
  type Lifecycle,
  type MaterializeInput,
  type MaterializeOutput,
  type PrepareInput,
  type PrepareOutput,
  type ReserveInput,
  type ReserveOutput,
  type ServiceInput,
  type ServiceOutput,
  type SyncInput,
  type SyncOutput,
  type TeardownInput,
  type TeardownOutput,
  type WorkspaceId,
} from "./schema.ts";

export type WorkspaceLifecycleState =
  | "reserved"
  | "materialized"
  | "prepared"
  | "ready"
  | "running"
  | "torn_down";

export type WorkspaceLedger = {
  workspace_id: WorkspaceId;
  branch: string;
  worktree_path: string;
  host_repo_slug: string;
  state: WorkspaceLifecycleState;
  reserved_at: string;
};

export type ResolveContext = {
  cwd: string;
  /** When supplied, skips git remote lookup (tests). */
  originUrl?: string | undefined;
};

/**
 * Pure: compute the 12-hex workspace_id from `(slug, branch)`.
 *
 * The plan initially proposed hashing the worktree path too, but that
 * would assign a different id to `reserve` (pre-switch, parent-repo
 * cwd, worktree does not yet exist) than to `prepare`/`sync`/`service`/
 * `teardown` (post-switch / post-start, worktree cwd). Hashing just
 * `(slug, branch)` keeps the id stable across that lifecycle boundary;
 * the worktree path stays in the ledger as audit-substrate data so
 * future drivers (devcontainer, nix devShell, CI pre-job) that
 * materialize at non-default paths can still recover the location.
 * Collision case — multiple parallel worktrees of the same branch in
 * the same repo — is not a supported shape; the worktrunk worktree-path
 * template already encodes branch. Revisit when a second driver lands
 * (tracked in ai-home-ul4mb): if devcontainer/devShell materializes at
 * a non-default path, the no-path-in-hash assumption needs to be re-tested.
 */
export function computeWorkspaceId(
  hostRepoSlug: string,
  branch: string,
  _worktreePath: string,
): WorkspaceId {
  void _worktreePath;
  const hash = createHash("sha256");
  hash.update(`${hostRepoSlug} ${branch}`);
  return hash.digest("hex").slice(0, 12);
}

function tryGit(args: string[], cwd: string): string | null {
  const r = spawnCapture(["git", ...args], { cwd });
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

function resolveRepoToplevel(cwd: string): string | null {
  const top = tryGit(["rev-parse", "--show-toplevel"], cwd);
  if (top) return top;
  // prx-ph7: a bare repo has no working tree, so `--show-toplevel` fails — but
  // that is exactly the cwd Claude Code runs `claude --worktree` hooks from (the
  // git common dir). Rather than depend on being launched inside a worktree, prx
  // resolves the layout itself: anchor on an existing sibling worktree (its
  // dirname is the worktree-root the convention places new worktrees under).
  // keeper's `git worktree add` already works from the bare repo; this just
  // feeds reserve/materialize a real worktree path to compute against.
  return firstNonBareWorktree(tryGit(["worktree", "list", "--porcelain"], cwd));
}

/**
 * Pick the first non-bare worktree path from `git worktree list --porcelain`.
 * The porcelain output is newline-separated attribute lines, one blank line
 * between entries; the bare repo's own entry carries a `bare` line, which we
 * skip. Pure (parses the captured text) so it is unit-testable without git.
 */
export function firstNonBareWorktree(porcelain: string | null): string | null {
  if (!porcelain) return null;
  for (const block of porcelain.split("\n\n")) {
    const lines = block.split("\n");
    if (lines.some((l) => l.trim() === "bare")) continue;
    const wt = lines.find((l) => l.startsWith("worktree "));
    if (wt) return wt.slice("worktree ".length).trim();
  }
  return null;
}

function resolveCommonDir(cwd: string): string | null {
  const out = tryGit(["rev-parse", "--git-common-dir"], cwd);
  if (!out) return null;
  return out.startsWith("/") ? out : join(cwd, out);
}

function resolveBranch(cwd: string): string | null {
  return tryGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
}

function resolveOrigin(cwd: string): string | null {
  return tryGit(["remote", "get-url", "origin"], cwd);
}

/**
 * Resolve workspace_id and ledger location from a cwd. When `branch`
 * or `worktreePath` is supplied, those override the cwd-derived values
 * (used by `reserve`, which is called before the branch is checked out).
 */
export function resolveWorkspaceContext(
  ctx: ResolveContext & {
    branch?: string | undefined;
    worktreePath?: string | undefined;
  },
): {
  workspaceId: WorkspaceId;
  hostRepoSlug: string;
  branch: string;
  worktreePath: string;
  ledgerPath: string;
} | null {
  const worktreePath = ctx.worktreePath ?? resolveRepoToplevel(ctx.cwd);
  if (!worktreePath) return null;
  const branch = ctx.branch ?? resolveBranch(worktreePath);
  if (!branch) return null;
  const originUrl = ctx.originUrl ?? resolveOrigin(worktreePath);
  if (!originUrl) return null;
  const segments = legacyGithubIdentitySegments(originUrl);
  if (!segments) return null;
  const hostRepoSlug = segments.join("/");
  const workspaceId = computeWorkspaceId(hostRepoSlug, branch, worktreePath);
  const commonDir = resolveCommonDir(worktreePath);
  if (!commonDir) return null;
  const ledgerPath = join(commonDir, "info", "workspace", `${workspaceId}.json`);
  return { workspaceId, hostRepoSlug, branch, worktreePath, ledgerPath };
}

function readLedger(ledgerPath: string): WorkspaceLedger | null {
  if (!existsSync(ledgerPath)) return null;
  try {
    return JSON.parse(readFileSync(ledgerPath, "utf8")) as WorkspaceLedger;
  } catch {
    return null;
  }
}

/** I-WS2: atomic write via tmp + rename. */
function atomicWriteFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, content);
  renameSync(tmpPath, path);
}

function writeLedger(ledgerPath: string, ledger: WorkspaceLedger): void {
  atomicWriteFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
}

function updateLedgerState(
  ledgerPath: string,
  state: WorkspaceLifecycleState,
): WorkspaceLedger | null {
  return updateLedger(ledgerPath, { state });
}

/** Patch one or more ledger fields atomically (I-WS2). */
function updateLedger(ledgerPath: string, patch: Partial<WorkspaceLedger>): WorkspaceLedger | null {
  const ledger = readLedger(ledgerPath);
  if (!ledger) return null;
  const next: WorkspaceLedger = { ...ledger, ...patch };
  writeLedger(ledgerPath, next);
  return next;
}

/**
 * Resolve an already-reserved workspace by its authoritative `workspace_id`,
 * independent of the cwd's current git HEAD.
 *
 * The gated verbs (prepare/sync/service/teardown) are handed the
 * `workspace_id` minted at reserve, and the ledger filename *is* that id.
 * Re-deriving the id by recomputing `(slug, branch)` from the cwd HEAD broke
 * the `materialized` intake/triage lifecycle (GH-2258): that runs in the
 * shared `mainx` worktree, which sits in detached HEAD, so `git rev-parse
 * --abbrev-ref HEAD` returns the literal "HEAD" and the recomputed id never
 * matched the id reserved under the ephemeral `intake/<date>-<short>` branch
 * — a false `no prior reserve`. Looking the ledger up by id directly restores
 * the documented invariant that `workspace_id` is the stable key (see
 * `computeWorkspaceId`). The ledger carries the authoritative `worktree_path`
 * so downstream tooling writes target the reserved worktree, not wherever the
 * verb happened to run.
 */
function resolveReservedLedger(
  cwd: string,
  workspaceId: WorkspaceId,
): { ledgerPath: string; ledger: WorkspaceLedger; worktreePath: string } | null {
  const cwdToplevel = resolveRepoToplevel(cwd);
  if (!cwdToplevel) return null;
  const commonDir = resolveCommonDir(cwdToplevel);
  if (!commonDir) return null;
  const ledgerPath = join(commonDir, "info", "workspace", `${workspaceId}.json`);
  const ledger = readLedger(ledgerPath);
  if (!ledger) return null;
  return { ledgerPath, ledger, worktreePath: ledger.worktree_path };
}

/**
 * GH-2338 (I-PROV1): resolve the canonical per-UoW anchored-chain ledger path
 * for the workspace rooted at `cwd`. This is the single source of truth shared
 * by the merge-guard verification side and the submit-publish emission side, so
 * a signed `push/v1` derivation lands at exactly the path the gate later reads
 * — without either side needing an explicit `--ledger`.
 *
 * Resolution reuses the by-id reserved-ledger lookup (#2273 / AC-5): the
 * workspace_id is the stable `(slug, branch)` key (not cwd HEAD), and the
 * canonical ledger only exists once a prior `reserve` has written the workspace
 * ledger (I-WS1). The provenance store sits beside the workspace ledger at
 * `<repoCommonDir>/info/provenance/<workspace_id>.sqlite`, mirroring the
 * `info/workspace/<id>.json` layout to keep the per-UoW artifact tree coherent.
 *
 * Returns `null` (no canonical ledger) when the cwd is not a recognized repo,
 * has no prior reserve, the common dir is unresolvable, or — per I-WS5 — the
 * reserved worktree_path resolves to the read-only `mainx` replica (we never
 * create a provenance DB under the replica; callers fail closed on `null`).
 */
export function resolveCanonicalChainLedger(
  cwd: string,
): { ledgerPath: string; workspaceId: WorkspaceId } | null {
  const ctx = resolveWorkspaceContext({ cwd });
  if (!ctx) return null;
  const reserved = resolveReservedLedger(cwd, ctx.workspaceId);
  if (!reserved) return null;
  // I-WS5: never resolve a provenance ledger under the read-only mainx replica.
  if (isMainxPath(reserved.worktreePath)) return null;
  const commonDir = resolveCommonDir(ctx.worktreePath);
  if (!commonDir) return null;
  return {
    ledgerPath: join(commonDir, "info", "provenance", `${ctx.workspaceId}.sqlite`),
    workspaceId: ctx.workspaceId,
  };
}

// ---------------------------------------------------------------------------
// reserve
// ---------------------------------------------------------------------------

export type ReserveDeps = {
  ensureBranchImpl?: typeof ensureBranch;
  /** Override the cwd-driven origin URL lookup (tests). */
  originUrl?: string;
  /** Override the cwd-driven repo toplevel resolver (tests). */
  worktreePath?: string;
};

const ENSURE_TO_RESERVE_STATUS: Record<EnsureBranchResult["status"], ReserveOutput["status"]> = {
  created: "created",
  "exists-local": "exists-local",
  "exists-remote": "exists-remote",
  skipped: "skipped",
  "base-unresolved": "base-unresolved",
  error: "error",
};

export function runReserve(
  input: ReserveInput,
  cwd: string,
  deps: ReserveDeps = {},
): ReserveOutput {
  const context = resolveWorkspaceContext({
    cwd,
    branch: input.branch,
    worktreePath: deps.worktreePath,
    originUrl: deps.originUrl,
  });
  if (!context) {
    return {
      workspace_id: "000000000000",
      branch_ref: input.branch,
      status: "error",
      error:
        "workspace.reserve: cwd is not a recognized GitHub repo (no origin or non-GitHub host)",
    };
  }

  const impl = deps.ensureBranchImpl ?? ensureBranch;
  const result = impl({
    name: input.branch,
    base: input.base,
    localOnly: input.local_only,
    // GH-2280: run git probes/fetch in the target repo, not the caller's cwd.
    // Without this, ensureBranch defaults to process.cwd() and misses the
    // reserved branch (and fetches the wrong origin), failing on credential-less CI.
    cwd,
  });

  const status = ENSURE_TO_RESERVE_STATUS[result.status];
  const error =
    result.status === "error" || result.status === "base-unresolved" ? result.message : undefined;

  // I-WS1: write the ledger so subsequent verbs can verify a prior
  // reservation. Skip on terminal-error paths so an `error` reservation
  // does not poison the gate.
  if (status !== "error" && status !== "base-unresolved") {
    const ledger: WorkspaceLedger = {
      workspace_id: context.workspaceId,
      branch: input.branch,
      worktree_path: context.worktreePath,
      host_repo_slug: context.hostRepoSlug,
      state: "reserved",
      reserved_at: new Date().toISOString(),
    };
    writeLedger(context.ledgerPath, ledger);
  }

  return {
    workspace_id: context.workspaceId,
    branch_ref: input.branch,
    status,
    ...(error ? { error } : {}),
  };
}

// ---------------------------------------------------------------------------
// materialize
// ---------------------------------------------------------------------------

export type MaterializeDeps = {
  /**
   * prx-0yf: ignored — the worktree git seam moved to keeper
   * (`runKeeperEnsureWorktree`). Retained for caller API compatibility.
   */
  spawn?: WorktreeSpawn;
  /** Override the cwd → repo-toplevel resolver (tests). */
  repoToplevel?: (cwd: string) => string | null;
  /** prx-0yf: inject keeper's git + fs seams (tests stub the worktree ops offline). */
  git?: KeeperEnsureWorktreeDeps["git"];
  exists?: KeeperEnsureWorktreeDeps["exists"];
  remove?: KeeperEnsureWorktreeDeps["remove"];
};

/**
 * Materialize the reserved branch on disk as a sibling worktree
 * (ai-home-rkg1w.1 §3.3). This is the step that was missing in GH-2258:
 * `reserve` only wrote the ledger + branch ref, so `openSession` had no
 * real worktree to chdir into. `materialize` runs `git worktree add`
 * (via the shared placement core) and records the authoritative
 * `worktree_path` + `state: "materialized"` on the ledger, which
 * `prepare` then resolves against.
 *
 * Idempotent: a path already registered as a worktree returns
 * `status: "exists"` without re-adding. I-WS1: a workspace with no prior
 * reserve fails closed (`status: "error"`).
 */
export function runMaterialize(
  input: MaterializeInput,
  cwd: string,
  deps: MaterializeDeps = {},
): MaterializeOutput {
  const reserved = resolveReservedLedger(cwd, input.workspace_id);
  if (!reserved) {
    return {
      workspace_id: input.workspace_id,
      worktree_path: "",
      branch: "",
      status: "error",
      error: "workspace.materialize: no prior reserve (run `prx workspace reserve` first)",
    };
  }
  const { ledgerPath, ledger } = reserved;
  // prx-0yf: the worktree git seam now lives in keeper (runKeeperEnsureWorktree);
  // runMaterialize no longer drives `git worktree` via the injected spawn.
  const repoTop = (deps.repoToplevel ?? resolveRepoToplevel)(cwd);
  if (!repoTop) {
    return {
      workspace_id: input.workspace_id,
      worktree_path: "",
      branch: ledger.branch,
      status: "error",
      error: "workspace.materialize: cannot resolve repo toplevel from cwd",
    };
  }
  const targetPath = expectedWorktreePath(repoTop, ledger.branch);

  try {
    // prx-0yf: keeper is the sole git-knower — delegate the worktree placement
    // AND the self-heal of stale/prunable state to it. (Previously a registered-
    // but-broken worktree was treated as a healthy "exists", yielding a worktree
    // with no `.git`; keeper now prunes + recreates it — fixes the #47
    // regression / prx-5h0.)
    const ensured = runKeeperEnsureWorktree({ branch: ledger.branch, targetPath }, repoTop, {
      ...(deps.git ? { git: deps.git } : {}),
      ...(deps.exists ? { exists: deps.exists } : {}),
      ...(deps.remove ? { remove: deps.remove } : {}),
    });
    updateLedger(ledgerPath, {
      worktree_path: ensured.worktree_path,
      state: "materialized",
    });
    return {
      workspace_id: input.workspace_id,
      worktree_path: ensured.worktree_path,
      branch: ledger.branch,
      // MaterializeOutput's status vocab is created|exists; keeper's self-heal
      // "recreated" collapses to "created" (a fresh tree on disk).
      status: ensured.status === "exists" ? "exists" : "created",
    };
  } catch (err) {
    const message =
      err instanceof WorktreeAddError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      workspace_id: input.workspace_id,
      worktree_path: targetPath,
      branch: ledger.branch,
      status: "error",
      error: `workspace.materialize: ${message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// prepare
// ---------------------------------------------------------------------------

export type PrepareDeps = {
  /**
   * Inject the beads-hydrate runner. The CLI wires the production
   * implementation from `src/beads/hydrate.ts`; tests pass a stub.
   * Returning `false` means hydrate is best-effort and skipped.
   */
  hydrateBeads?: (cwd: string) => boolean;
  /**
   * Optional `.beads/redirect` writer for the `materialized` lifecycle
   * (triage/intake), which skips hydrate. There is no production default
   * (the bd/Dolt redirect machinery was removed with GH-1012); when unset
   * the materialized lifecycle simply writes no redirect. Tests may still
   * inject a stub. Receives `(srcWorktree, destWorktree)` and returns files
   * written.
   */
  writeRedirect?: (srcWorktree: string, destWorktree: string) => string[];
};

function ensurePrxExcludesForWorkspace(repoRoot: string): {
  files_written: string[];
} {
  const workspaceConfig = loadWorkspaceConfig(repoRoot);
  const result = ensurePrxExcludes({
    repoRoot,
    workspaceTrack: workspaceConfig.track,
  });
  const filesWritten: string[] = [];
  if (
    result.excludePath &&
    (result.excludeUpdatedRules.length > 0 || result.excludeRemovedRules.length > 0)
  ) {
    filesWritten.push(result.excludePath);
  }
  return { files_written: filesWritten };
}

export function runPrepare(
  input: PrepareInput,
  cwd: string,
  deps: PrepareDeps = {},
): PrepareOutput {
  const reserved = resolveReservedLedger(cwd, input.workspace_id);
  if (!reserved) {
    return gateFailure(input.workspace_id, "prepare", {
      files_written: [],
      beads_hydrated: false,
    }) as PrepareOutput;
  }
  // I-WS5: never mutate the read-only mainx replica.
  if (isMainxPath(reserved.worktreePath)) {
    return mainxGuard(input.workspace_id, "prepare", {
      files_written: [],
      beads_hydrated: false,
    }) as PrepareOutput;
  }
  const { ledgerPath, worktreePath } = reserved;

  const filesWritten: string[] = [];
  let beadsHydrated = false;
  try {
    const excludeResult = ensurePrxExcludesForWorkspace(worktreePath);
    filesWritten.push(...excludeResult.files_written);

    if (input.lifecycle !== "materialized") {
      if (deps.hydrateBeads) {
        beadsHydrated = deps.hydrateBeads(worktreePath) === true;
      }
    } else if (deps.writeRedirect) {
      // The `materialized` lifecycle (triage/intake) skips hydrate and runs an
      // agent in the new worktree directly. Historically this wrote a
      // `.beads/redirect` so `bd` resolved the launching workspace's shared Dolt
      // server; that machinery was removed with GH-1012, so there is no
      // production redirect writer. The injectable seam is retained for tests.
      // Source = the pre-chdir launching workspace. openSession chdir's into
      // the new worktree before prepare, so `cwd` IS the worktree here; using
      // it would make the redirect a no-op (src === dest). `input.launchCwd`
      // carries the workspace the operator launched from (mainx); the CLI omits
      // it (no chdir) and falls back to `cwd`.
      const source = input.launchCwd ?? cwd;
      filesWritten.push(...deps.writeRedirect(source, worktreePath));
    }

    updateLedgerState(ledgerPath, "prepared");
    return {
      workspace_id: input.workspace_id,
      files_written: filesWritten,
      beads_hydrated: beadsHydrated,
      status: "ok",
    };
  } catch (err) {
    return {
      workspace_id: input.workspace_id,
      files_written: filesWritten,
      beads_hydrated: beadsHydrated,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

export function runSync(input: SyncInput, cwd: string): SyncOutput {
  const reserved = resolveReservedLedger(cwd, input.workspace_id);
  if (!reserved) {
    return gateFailure(input.workspace_id, "sync", {
      ignore_synced: false,
      tooling_drift_corrected: [],
    }) as SyncOutput;
  }
  // I-WS5: never mutate the read-only mainx replica.
  if (isMainxPath(reserved.worktreePath)) {
    return mainxGuard(input.workspace_id, "sync", {
      ignore_synced: false,
      tooling_drift_corrected: [],
    }) as SyncOutput;
  }
  const { worktreePath } = reserved;

  try {
    const workspaceConfig = loadWorkspaceConfig(worktreePath);
    const result = ensurePrxExcludes({
      repoRoot: worktreePath,
      workspaceTrack: workspaceConfig.track,
    });
    const drift = [...result.excludeRemovedRules, ...result.excludeUpdatedRules];
    const status: SyncOutput["status"] = drift.length === 0 ? "noop" : "ok";
    return {
      workspace_id: input.workspace_id,
      ignore_synced: result.excludePath != null,
      tooling_drift_corrected: drift,
      status,
    };
  } catch (err) {
    return {
      workspace_id: input.workspace_id,
      ignore_synced: false,
      tooling_drift_corrected: [],
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

const WORKTREE_COMPOSE_PAIR: readonly [string, string] = [
  "docker-compose.yml",
  "compose.worktree.yml",
];

export type ServiceDeps = {
  /**
   * Run a docker compose command. Default implementation shells out to
   * `docker compose -f <a> -f <b> up -d` / `down`. Tests inject a stub
   * that records the invocation.
   */
  runCompose?: (args: { cwd: string; files: string[]; action: "up" | "down" }) => {
    exitCode: number;
    stderr?: string;
  };
};

function defaultRunCompose(args: { cwd: string; files: string[]; action: "up" | "down" }): {
  exitCode: number;
  stderr?: string;
} {
  const filesArgs: string[] = [];
  for (const f of args.files) {
    filesArgs.push("-f", f);
  }
  const composeArgs =
    args.action === "up"
      ? ["compose", ...filesArgs, "up", "-d"]
      : ["compose", ...filesArgs, "down"];
  const r = spawnCapture(["docker", ...composeArgs], { cwd: args.cwd });
  return {
    exitCode: r.status ?? 1,
    stderr: r.stderr,
  };
}

export function runService(
  input: ServiceInput,
  cwd: string,
  deps: ServiceDeps = {},
): ServiceOutput {
  const reserved = resolveReservedLedger(cwd, input.workspace_id);
  if (!reserved) {
    return gateFailure(input.workspace_id, "service", {
      compose_files: [],
    }) as ServiceOutput;
  }
  // I-WS5: never mutate the read-only mainx replica.
  if (isMainxPath(reserved.worktreePath)) {
    return mainxGuard(input.workspace_id, "service", {
      compose_files: [],
    }) as ServiceOutput;
  }
  const { ledgerPath, worktreePath } = reserved;

  // I-WS3: auto-mode with no profile is a no-op. "No profile" for this
  // repo means neither `docker-compose.yml` + `compose.worktree.yml`
  // exists. The legacy `wtctl up/down --auto` profile config (XDG) is
  // intentionally not consulted — that surface retires with wtctl.
  const haveBoth = WORKTREE_COMPOSE_PAIR.every((f) => existsSync(join(worktreePath, f)));
  if (!haveBoth) {
    if (input.auto) {
      return {
        workspace_id: input.workspace_id,
        status: "no-profile",
        compose_files: [],
      };
    }
    return {
      workspace_id: input.workspace_id,
      status: "skipped",
      compose_files: [],
      error: "no compose profile (need docker-compose.yml + compose.worktree.yml)",
    };
  }

  const runner = deps.runCompose ?? defaultRunCompose;
  const result = runner({
    cwd: worktreePath,
    files: [...WORKTREE_COMPOSE_PAIR],
    action: input.action === "start" ? "up" : "down",
  });

  if (result.exitCode !== 0) {
    return {
      workspace_id: input.workspace_id,
      status: "error",
      compose_files: [...WORKTREE_COMPOSE_PAIR],
      error: result.stderr || `docker compose exited ${result.exitCode}`,
    };
  }

  if (input.action === "start") {
    updateLedgerState(ledgerPath, "running");
    return {
      workspace_id: input.workspace_id,
      status: "started",
      compose_files: [...WORKTREE_COMPOSE_PAIR],
    };
  }
  updateLedgerState(ledgerPath, "prepared");
  return {
    workspace_id: input.workspace_id,
    status: "stopped",
    compose_files: [...WORKTREE_COMPOSE_PAIR],
  };
}

// ---------------------------------------------------------------------------
// teardown
// ---------------------------------------------------------------------------

export function runTeardown(input: TeardownInput, cwd: string): TeardownOutput {
  const reserved = resolveReservedLedger(cwd, input.workspace_id);
  if (!reserved) {
    if (input.force) {
      return {
        workspace_id: input.workspace_id,
        status: "skipped",
        cleaned: [],
      };
    }
    return gateFailure(input.workspace_id, "teardown", {
      cleaned: [],
    }) as TeardownOutput;
  }
  // I-WS5: the mainx guard wins over `--force` — a teardown whose reserved
  // ledger resolves worktree_path to the read-only replica always fails
  // closed, never silently skips.
  if (isMainxPath(reserved.worktreePath)) {
    return mainxGuard(input.workspace_id, "teardown", {
      cleaned: [],
    }) as TeardownOutput;
  }
  const { ledgerPath } = reserved;

  const cleaned: string[] = [];
  // Move ledger to torn_down state in-place; the file itself stays as
  // an audit-substrate record (cleanup of the ledger file is the
  // git-common-dir GC's job, not the workspace actor's).
  updateLedgerState(ledgerPath, "torn_down");
  cleaned.push(ledgerPath);
  return {
    workspace_id: input.workspace_id,
    status: "torn-down",
    cleaned,
  };
}

// ---------------------------------------------------------------------------
// I-WS1 gate helper
// ---------------------------------------------------------------------------

type GateBaseOutput =
  | Pick<PrepareOutput, "files_written" | "beads_hydrated">
  | Pick<SyncOutput, "ignore_synced" | "tooling_drift_corrected">
  | Pick<ServiceOutput, "compose_files">
  | Pick<TeardownOutput, "cleaned">;

function gateFailure(
  workspaceId: WorkspaceId,
  verb: "prepare" | "sync" | "service" | "teardown",
  extras: GateBaseOutput,
): PrepareOutput | SyncOutput | ServiceOutput | TeardownOutput {
  // I-WS1: every verb except `reserve` requires a prior WORKSPACE_RESERVED.
  // Returning `error` is the closed-fail signal the CLI surfaces as a
  // non-zero exit so a driver wired wrong gets a clear failure.
  return {
    workspace_id: workspaceId,
    status: "error",
    error: `workspace.${verb}: no prior reserve (run \`prx workspace reserve\` first)`,
    ...extras,
  } as PrepareOutput | SyncOutput | ServiceOutput | TeardownOutput;
}

/**
 * I-WS5 fail-closed guard: refuse a gated mutation whose reserved ledger
 * resolves `worktree_path` to the read-only `mainx` replica. Parallels
 * `gateFailure` — returns the per-verb `error` output shape so the CLI
 * surfaces a non-zero exit. The guard wins over `teardown --force`: callers
 * place it before the force short-circuit so isolation can't be bypassed.
 */
function mainxGuard(
  workspaceId: WorkspaceId,
  verb: "prepare" | "sync" | "service" | "teardown",
  extras: GateBaseOutput,
): PrepareOutput | SyncOutput | ServiceOutput | TeardownOutput {
  return {
    workspace_id: workspaceId,
    status: "error",
    error: `workspace.${verb}: refusing to operate on read-only mainx replica — materialize a sibling worktree first`,
    ...extras,
  } as PrepareOutput | SyncOutput | ServiceOutput | TeardownOutput;
}

// Public re-export so callers can detect the materialized lifecycle
// without importing from schema directly.
export type { Lifecycle };
