/**
 * beads workspace self-heal (GH-228).
 *
 * "beads always works" needs a one-command repair for a worktree whose beads
 * clone is unhealthy — the canonical-prefix repair (force-pushed a prefix into
 * the dolthub beads) left every pre-repair worktree clone diverged and still
 * prefixless, so its `bd create` fails with `issue_prefix config is missing`.
 *
 * {@link diagnoseBeads} is the read-only probe: a worktree is healthy iff
 * `bd config get issue_prefix` resolves to a prefix (an unhealthy clone prints
 * `issue_prefix (not set)`). {@link healBeads} re-bootstraps an unhealthy clone
 * from the (now-correct) canonical: stop the per-worktree dolt server, clear the
 * stale `.beads/dolt/<db>` cache (re-clonable; the canonical is authoritative),
 * `bd bootstrap --yes`, then re-probe. A healthy clone is a no-op.
 *
 * All process / filesystem effects are injected seams, so the orchestration is
 * unit-tested offline (a fake runner); the live path runs against a real bd.
 */

import { rmSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { runCaptured, type CommandRunner, type RunOptions } from "@bounded-systems/proc";

/** Injected effects (default to real proc/fs); tests stub them offline. */
export interface BeadsDoctorDeps {
  /** Run a command to completion without throwing on non-zero (default {@link runCaptured}). */
  run?: CommandRunner | undefined;
  /** Does a path exist? (default {@link existsSync}). */
  exists?: ((path: string) => boolean) | undefined;
  /** Recursively remove a directory (default `rmSync(..., recursive, force)`). */
  rmrf?: ((path: string) => void) | undefined;
  /** The worktree whose beads is diagnosed/healed (default the process cwd). */
  cwd?: string | undefined;
}

/** The health of a worktree's beads clone. */
export interface BeadsDiagnosis {
  /** Healthy iff the workspace has an issue prefix (writes will work). */
  healthy: boolean;
  /** The resolved issue prefix, or null when unset (the broken state). */
  prefix: string | null;
  /** The dolt database name (used to locate the cache to clear), or null. */
  database: string | null;
}

/** The outcome of a heal attempt. */
export interface BeadsHealResult {
  repaired: boolean;
  before: BeadsDiagnosis;
  after: BeadsDiagnosis;
  /** What the heal did, for surfacing to the operator. */
  action: "none" | "re-bootstrapped";
}

const NOT_SET = "(not set)";

/** Non-throwing run options at an optional cwd (exactOptionalPropertyTypes-safe). */
function runOpts(cwd: string | undefined): RunOptions {
  return cwd !== undefined ? { cwd, check: false } : { check: false };
}

/** Parse a `bd config get <key>` reply into a value, or null when unset. */
function parseConfigValue(stdout: string): string | null {
  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (line === undefined || line.includes(NOT_SET)) return null;
  return line;
}

function bdConfigGet(run: CommandRunner, key: string, cwd: string | undefined): string | null {
  const res = run(["bd", "config", "get", key], runOpts(cwd));
  if (res.status !== 0) return null;
  return parseConfigValue(res.stdout);
}

/**
 * Read-only probe of a worktree's beads health. Healthy iff `issue_prefix`
 * resolves — an unhealthy (pre-repair / diverged) clone has none, so its writes
 * fail with `issue_prefix config is missing`.
 */
export function diagnoseBeads(deps: BeadsDoctorDeps = {}): BeadsDiagnosis {
  const run = deps.run ?? runCaptured;
  const prefix = bdConfigGet(run, "issue_prefix", deps.cwd);
  const database = bdConfigGet(run, "dolt_database", deps.cwd);
  return { healthy: prefix !== null, prefix, database };
}

/**
 * Re-bootstrap an unhealthy beads clone from the canonical. No-op when already
 * healthy. The sequence mirrors the manual recipe: stop the per-worktree dolt
 * server, clear the stale `.beads/dolt/<db>` cache, `bd bootstrap --yes`, re-probe.
 */
export function healBeads(deps: BeadsDoctorDeps = {}): BeadsHealResult {
  const run = deps.run ?? runCaptured;
  const exists = deps.exists ?? existsSync;
  const rmrf = deps.rmrf ?? ((p: string) => rmSync(p, { recursive: true, force: true }));
  const cwd = deps.cwd;

  const before = diagnoseBeads(deps);
  if (before.healthy) {
    return { repaired: false, before, after: before, action: "none" };
  }

  // Stop the per-worktree dolt server so the cache can be cleared + re-cloned.
  // Best-effort: an embedded-mode workspace has no server and reports so.
  run(["bd", "dolt", "stop"], runOpts(cwd));

  // Clear the stale dolt cache (re-clonable — the canonical is authoritative),
  // so `bd bootstrap` clones fresh rather than refusing with "database exists".
  if (before.database !== null) {
    const dbDir = join(cwd ?? ".", ".beads", "dolt", before.database);
    if (exists(dbDir)) rmrf(dbDir);
  }

  run(["bd", "bootstrap", "--yes"], runOpts(cwd));

  const after = diagnoseBeads(deps);
  return { repaired: after.healthy, before, after, action: "re-bootstrapped" };
}
