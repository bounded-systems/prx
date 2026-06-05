/**
 * bootstrap-worktree — idempotently close the two gaps that leave a fresh
 * `wt switch --create` worktree half-broken (GH-495):
 *
 *   1. Beads: write `.beads/redirect` so `bd ready` resolves to the main
 *      repo's `.beads` instead of blowing up with "database not found".
 *   2. PRX contract: run the normal init flow so `.pr/local/pr.json` exists
 *      and `prx contract status` / `/pr-state` work without manual `prx init`.
 *
 * Invoked by `prx tools wt bootstrap`, which the worktrunk `[post-create]`
 * hook calls exactly once per new worktree. Best-effort: every branch has a
 * "skipped-<reason>" status so the hook never blocks a real switch.
 *
 * The redirect format matches upstream `bd worktree create`: a single line
 * with the relative path from `<worktree>/.beads/` to `<main>/.beads`,
 * followed by a newline. See the verification commit on GH-495 for how the
 * format was discovered (`bd worktree create` on a scratch worktree).
 *
 * Read-only git ops go through execGit (policy-enforced). Filesystem writes
 * go directly through node:fs because they are prx-internal, not agent-facing.
 */

import { chmodSync, existsSync, readFileSync } from "node:fs";

import { rewriteFileAtomic } from "./atomic_file.ts";
import { join, relative, resolve } from "node:path";
import { execGit } from "@bounded-systems/git";
import {
  repairBdSchema as defaultRepairBdSchema,
  type BdSchemaRepairResult,
} from "../beads/schema_repair.ts";
import { resolveMainWorktree as defaultResolveMainWorktree } from "../beads/primary_worktree.ts";

export type BeadsBootstrapStatus =
  | "wrote-redirect"
  | "rewrote-redirect-target"
  | "skipped-no-beads"
  | "skipped-redirect-exists"
  | "skipped-no-main-beads"
  | "skipped-main-is-cwd"
  | "skipped-no-git-common-dir"
  | "error";

/**
 * GH-653: when bootstrap touches a feature worktree, it inspects the
 * `.beads` directory for stale per-worktree state that should be cleaned up
 * by the future `prx beads repair-redirect` command (Phase 3). All fields
 * are inform-only — bootstrap never removes anything itself.
 */
export type BeadsStaleState = {
  /** `.beads/dolt/{db}` exists (feature worktree owns its own dolt data) */
  dolt: boolean;
  /** `.beads/dolt-server.pid` exists */
  serverPid: boolean;
  /** `.beads/dolt-server.port` exists */
  serverPort: boolean;
  /** `.beads/dolt-server.lock` exists */
  serverLock: boolean;
};

export type ContractBootstrapStatus =
  | "wrote-contract"
  | "skipped-no-prx-toml"
  | "skipped-contract-exists"
  | "skipped-no-repo-root"
  | "error";

export type BeadsBootstrapResult = {
  status: BeadsBootstrapStatus;
  redirectPath: string | null;
  redirectTarget: string | null;
  message?: string;
  /**
   * GH-1152: when bootstrap touches a worktree that has its own `.beads`,
   * it also runs the lightweight bd-schema repair query to trigger upstream
   * compat migration 017. The result is informational — bootstrap still
   * succeeds even if the repair shells out and fails (logged here for the
   * post-create hook to surface).
   */
  schemaRepair?: BdSchemaRepairResult;
  /**
   * GH-653: stale per-worktree state detected on a feature worktree (the
   * worktree was created before the redirect-only invariant landed, or has
   * been bootstrapped against the buggy decision tree). Cleanup ships in
   * Phase 3's `prx beads repair-redirect` command — bootstrap only reports.
   */
  staleState?: BeadsStaleState;
};

export type ContractBootstrapResult = {
  status: ContractBootstrapStatus;
  contractPath: string | null;
  message?: string;
};

export type BootstrapResult = {
  beads: BeadsBootstrapResult;
  contract: ContractBootstrapResult;
  /** 0 unless a sub-step reported a hard error (unexpected IO failure). */
  exitCode: number;
};

export type BootstrapDeps = {
  /** Resolve the main worktree's root directory. Returns null when unresolvable. */
  resolveMainWorktree: (cwd: string) => string | null;
  /** Resolve the repo's top-level for the given cwd. */
  resolveRepoRoot: (cwd: string) => string | null;
  /**
   * Initialize a PR contract. Mirrors the shape of initContract in cli.ts so
   * the real implementation can be injected without pulling in its heavy
   * dependency graph here. Resolves on success; rejects on fatal error.
   */
  initContract: (outputPath: string) => Promise<unknown>;
  /**
   * GH-1152: optionally trigger the bd schema compat migration on
   * worktrees that own a `.beads` directory. Defaults to the real
   * `repairBdSchema`; tests inject a stub. Omit (or pass null) to skip
   * the trigger entirely (e.g. environments without `bd` on PATH).
   */
  repairBdSchema?: ((cwd: string) => BdSchemaRepairResult) | null;
};

/**
 * Default deps: use git to resolve paths, call the real initContract.
 * Kept out-of-module so tests can swap them without touching real git/fs.
 */
export function buildDefaultDeps(
  initContractImpl: (outputPath: string) => Promise<unknown>,
): BootstrapDeps {
  return {
    // GH-653: delegate to the shared helper so primary/feature classification
    // is consistent between bootstrap and hydrate.
    resolveMainWorktree: (cwd) => defaultResolveMainWorktree(cwd),
    resolveRepoRoot: (cwd) => gitOutput(["rev-parse", "--show-toplevel"], cwd),
    initContract: initContractImpl,
    repairBdSchema: defaultRepairBdSchema,
  };
}

function gitOutput(args: string[], cwd: string): string | null {
  const r = execGit({ subcommand: args[0]!, args: args.slice(1), cwd });
  if (r.exitCode !== 0) return null;
  const out = r.stdout.trim();
  return out.length > 0 ? out : null;
}

function readDoltDatabaseName(beadsDir: string): string | null {
  const metadataPath = join(beadsDir, "metadata.json");
  if (!existsSync(metadataPath)) return null;
  try {
    const raw = readFileSync(metadataPath, "utf8");
    const parsed = JSON.parse(raw) as { dolt_database?: unknown };
    if (typeof parsed.dolt_database !== "string" || !parsed.dolt_database) {
      return null;
    }
    return parsed.dolt_database;
  } catch {
    return null;
  }
}

/**
 * GH-653: detect (but do not remove) stale per-worktree dolt state on a
 * feature worktree. Returns `undefined` when no stale artifacts exist —
 * keeps the result JSON clean for the common healthy case.
 */
function detectStaleState(beadsDir: string): BeadsStaleState | undefined {
  const doltDb = readDoltDatabaseName(beadsDir);
  const stale: BeadsStaleState = {
    dolt: doltDb ? existsSync(join(beadsDir, "dolt", doltDb)) : false,
    serverPid: existsSync(join(beadsDir, "dolt-server.pid")),
    serverPort: existsSync(join(beadsDir, "dolt-server.port")),
    serverLock: existsSync(join(beadsDir, "dolt-server.lock")),
  };
  if (!stale.dolt && !stale.serverPid && !stale.serverPort && !stale.serverLock) {
    return undefined;
  }
  return stale;
}

function bootstrapBeads(cwd: string, deps: BootstrapDeps): BeadsBootstrapResult {
  const beadsDir = join(cwd, ".beads");
  if (!existsSync(beadsDir)) {
    return { status: "skipped-no-beads", redirectPath: null, redirectTarget: null };
  }

  // GH-442: .beads carries local workflow state; harden it to owner-only.
  // Idempotent — safe to re-run on already-bootstrapped worktrees to migrate
  // pre-existing 0755 dirs to 0700.
  try {
    chmodSync(beadsDir, 0o700);
  } catch (err) {
    return {
      status: "error",
      redirectPath: null,
      redirectTarget: null,
      message: `chmod 0700 ${beadsDir} failed: ${(err as Error).message}`,
    };
  }

  // GH-653: classify primary vs feature FIRST. The previous decision tree
  // short-circuited on `.beads/dolt/{db}` existence before ever computing
  // the redirect, which caused feature worktrees that had accumulated their
  // own dolt data (via the now-removed hydrate path) to never get a redirect
  // file written. Classification is structural via git common-dir; it cannot
  // be fooled by stale on-disk artifacts.
  const mainWorktree = deps.resolveMainWorktree(cwd);
  if (!mainWorktree) {
    return {
      status: "skipped-no-git-common-dir",
      redirectPath: null,
      redirectTarget: null,
      message: "could not resolve git common dir from cwd",
    };
  }

  const redirectPath = join(beadsDir, "redirect");

  if (resolve(mainWorktree) === resolve(cwd)) {
    // Primary worktree: it owns the canonical .beads, no redirect needed.
    return { status: "skipped-main-is-cwd", redirectPath, redirectTarget: null };
  }

  // Feature worktree: must always have a redirect to primary's .beads.
  const mainBeadsDir = join(mainWorktree, ".beads");
  if (!existsSync(mainBeadsDir)) {
    return {
      status: "skipped-no-main-beads",
      redirectPath,
      redirectTarget: mainBeadsDir,
      message: `main worktree ${mainWorktree} has no .beads directory`,
    };
  }

  const relativeTarget = relative(beadsDir, mainBeadsDir);
  const expectedRedirectContent = `${relativeTarget}\n`;
  const staleState = detectStaleState(beadsDir);

  // Read + rewrite the redirect through one descriptor (rewriteFileAtomic)
  // rather than existsSync-then-read-then-write (CodeQL js/file-system-race).
  let previous: string | null = null;
  let outcome: { existed: boolean; wrote: boolean };
  try {
    outcome = rewriteFileAtomic(redirectPath, (current) => {
      previous = current;
      // Already pointing at the right target — leave it untouched.
      if (current === expectedRedirectContent) return null;
      return expectedRedirectContent;
    });
  } catch (err) {
    return {
      status: "error",
      redirectPath,
      redirectTarget: mainBeadsDir,
      message: (err as Error).message,
    };
  }

  let result: BeadsBootstrapResult;
  if (!outcome.existed) {
    result = { status: "wrote-redirect", redirectPath, redirectTarget: mainBeadsDir };
  } else if (!outcome.wrote) {
    result = { status: "skipped-redirect-exists", redirectPath, redirectTarget: mainBeadsDir };
  } else {
    result = {
      status: "rewrote-redirect-target",
      redirectPath,
      redirectTarget: mainBeadsDir,
      message: `rewrote redirect: was ${(previous ?? "").trim()}, now ${relativeTarget}`,
    };
  }
  if (staleState) result.staleState = staleState;
  return result;
}

async function bootstrapContract(
  cwd: string,
  deps: BootstrapDeps,
): Promise<ContractBootstrapResult> {
  const repoRoot = deps.resolveRepoRoot(cwd);
  if (!repoRoot) {
    return {
      status: "skipped-no-repo-root",
      contractPath: null,
      message: "could not resolve repo root from cwd",
    };
  }

  const prxTomlPath = join(repoRoot, "prx.toml");
  if (!existsSync(prxTomlPath)) {
    return { status: "skipped-no-prx-toml", contractPath: null };
  }

  const contractPath = join(repoRoot, ".pr", "local", "pr.json");
  if (existsSync(contractPath)) {
    return { status: "skipped-contract-exists", contractPath };
  }

  try {
    await deps.initContract(contractPath);
  } catch (err) {
    return {
      status: "error",
      contractPath,
      message: (err as Error).message,
    };
  }

  return { status: "wrote-contract", contractPath };
}

export async function bootstrapWorktree(
  cwd: string,
  deps: BootstrapDeps,
): Promise<BootstrapResult> {
  const beads = bootstrapBeads(cwd, deps);
  // GH-1152: trigger upstream compat migration 017 on worktrees that own a
  // `.beads` directory. Strictly informational — never fails bootstrap, even
  // if `bd` itself errors. Skipped on `skipped-no-beads` (nothing to repair),
  // on `error` (the prior step already flagged a hard failure), and when the
  // dep is null (test paths that disable bd).
  if (
    deps.repairBdSchema
    && beads.status !== "skipped-no-beads"
    && beads.status !== "error"
  ) {
    try {
      beads.schemaRepair = deps.repairBdSchema(cwd);
    } catch (err) {
      beads.schemaRepair = {
        status: "repair_failed",
        durationMs: 0,
        command: "bd stats --json",
        message: (err as Error).message,
      };
    }
  }
  const contract = await bootstrapContract(cwd, deps);
  const exitCode = beads.status === "error" || contract.status === "error" ? 1 : 0;
  return { beads, contract, exitCode };
}

export function formatBootstrapResult(
  result: BootstrapResult,
  format: "plain" | "json",
): string {
  if (format === "json") return JSON.stringify(result, null, 2);

  const lines: string[] = [];
  lines.push(`beads: ${result.beads.status}${result.beads.message ? ` — ${result.beads.message}` : ""}`);
  if (
    (result.beads.status === "wrote-redirect" || result.beads.status === "rewrote-redirect-target")
    && result.beads.redirectTarget
  ) {
    lines.push(`  → ${result.beads.redirectTarget}`);
  }
  // GH-653: surface stale per-worktree state and point at the future repair
  // command. Cleanup itself ships in Phase 3.
  if (result.beads.staleState) {
    const s = result.beads.staleState;
    const parts: string[] = [];
    if (s.dolt) parts.push("dolt-data");
    if (s.serverPid) parts.push("dolt-server.pid");
    if (s.serverPort) parts.push("dolt-server.port");
    if (s.serverLock) parts.push("dolt-server.lock");
    lines.push(`  stale: ${parts.join(", ")}`);
    lines.push(`  hint: run 'prx beads repair-redirect' to clean up (Phase 3)`);
  }
  if (result.beads.schemaRepair) {
    lines.push(`  bd-schema: ${result.beads.schemaRepair.status} (${result.beads.schemaRepair.durationMs}ms)`);
  }
  lines.push(`contract: ${result.contract.status}${result.contract.message ? ` — ${result.contract.message}` : ""}`);
  if (result.contract.status === "wrote-contract" && result.contract.contractPath) {
    lines.push(`  → ${result.contract.contractPath}`);
  }
  return lines.join("\n");
}
