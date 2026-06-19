/**
 * prx-jkb: point a freshly materialized worktree's beads at the launching
 * workspace via `.beads/redirect`.
 *
 * The `triage`/`intake` `materialized` lifecycle creates a worktree and runs
 * an agent in it directly, skipping the hydrate path. With no `.beads/redirect`,
 * `bd` resolves a **per-worktree-path-keyed** Dolt server and spawns its own on
 * a fresh port (the port-drift / spawn-storm bug) instead of connecting to the
 * shared server the operator is already using.
 *
 * The earlier connection-stamp approach (copying `dolt-server.port` etc.) did
 * NOT work: bd re-derives the server identity from the worktree path and spawns
 * regardless of the stamped port. What works is `.beads/redirect` — bd reads it
 * and resolves all beads operations against the target `.beads`, using *its*
 * server. The GH-653 redirect (bootstrap_worktree.ts) can't help here because
 * `resolveMainWorktree` returns null in a bare-repo worktree layout, so we write
 * the redirect directly: prx controls materialization and knows the launching
 * workspace.
 *
 * We write an **absolute** target. bd resolves a *relative* redirect against the
 * worktree root (not `.beads`), which is off-by-one in nested layouts; an
 * absolute path is unambiguous and verified to make bd connect to the shared
 * server with no spawn.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Write `<destWorktree>/.beads/redirect` pointing at the launching workspace's
 * `.beads` (absolute) so `bd` in the materialized worktree resolves to that
 * workspace's Dolt server instead of spawning its own. If the source is itself
 * a redirected worktree, deref to its ultimate target so we never chain.
 * Returns the path written (or [] when there is nothing to point at, or the
 * source is the destination).
 */
export function writeBeadsRedirect(srcWorktree: string, destWorktree: string): string[] {
  const srcBeads = join(srcWorktree, ".beads");
  if (!existsSync(srcBeads) || resolve(srcWorktree) === resolve(destWorktree)) {
    return [];
  }

  // Deref: if the launching workspace is itself redirected, point at the
  // ultimate canonical .beads rather than chaining through it.
  let target = resolve(srcBeads);
  const srcRedirect = join(srcBeads, "redirect");
  if (existsSync(srcRedirect)) {
    const existing = readFileSync(srcRedirect, "utf8").trim();
    if (existing) {
      // bd resolves a relative redirect against the worktree root.
      target = isAbsolute(existing) ? existing : resolve(srcWorktree, existing);
    }
  }

  const destBeads = join(destWorktree, ".beads");
  mkdirSync(destBeads, { recursive: true, mode: 0o700 });
  const redirectPath = join(destBeads, "redirect");
  writeFileSync(redirectPath, `${target}\n`);
  // GH-442: keep .beads owner-only.
  try {
    chmodSync(destBeads, 0o700);
  } catch {
    // best-effort hardening; never fail the redirect on a chmod error
  }
  return [redirectPath];
}
