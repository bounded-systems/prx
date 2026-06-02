/**
 * prx-jkb: stamp the canonical Dolt connection into a freshly materialized
 * worktree.
 *
 * The `triage`/`intake` `materialized` lifecycle creates a worktree and runs
 * an agent in it directly, skipping the hydrate path. With no connection
 * config in its `.beads`, `bd` auto-detects a free port and spawns a stray
 * per-worktree Dolt server instead of connecting to the shared server the
 * operator is already using (the "port drift" / spawn-storm bug).
 *
 * The redirect mechanism (GH-653, `bootstrap_worktree.ts`) can't help here: it
 * resolves the primary worktree structurally via `git rev-parse
 * --git-common-dir`, which returns `null` for a bare-repo worktree layout — so
 * it's inert in exactly the setup prx runs in. Instead we copy the connection
 * explicitly from the launching workspace, which prx fully controls at
 * materialize time. This is layout-independent (no git-structure heuristic) and
 * is the right shape for ephemeral Lima/devShell/container workspaces too: the
 * stamped endpoint simply becomes the socket or host:port of the one Dolt
 * daemon.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Connection-defining files copied from the source workspace's `.beads`.
 * Deliberately excludes the `dolt/` data directory (per-worktree local clone)
 * and runtime artifacts (`dolt-server.pid`/`.lock`/`.log`).
 *
 * - `dolt-server.port` — the TCP port of the server to connect to.
 * - `metadata.json` — backend + `dolt_database` (the DB name on that server).
 * - `config.yaml` — `sync.remote` and other workspace config bd expects.
 */
const CONNECTION_FILES = [
  "dolt-server.port",
  "metadata.json",
  "config.yaml",
] as const;

/**
 * Copy the Dolt connection files from `srcWorktree`'s `.beads` into
 * `destWorktree`'s `.beads` so `bd` in the destination resolves to the same
 * server. Best-effort and idempotent: skips files absent in the source or
 * already present in the destination; never copies the `dolt/` data dir.
 * Returns the absolute paths actually written.
 */
export function stampBeadsConnection(
  srcWorktree: string,
  destWorktree: string,
): string[] {
  const srcBeads = join(srcWorktree, ".beads");
  const destBeads = join(destWorktree, ".beads");
  // Nothing to inherit, or the destination is the source itself.
  if (!existsSync(srcBeads) || join(srcWorktree) === join(destWorktree)) {
    return [];
  }

  mkdirSync(destBeads, { recursive: true, mode: 0o700 });
  const written: string[] = [];
  for (const file of CONNECTION_FILES) {
    const src = join(srcBeads, file);
    const dest = join(destBeads, file);
    if (existsSync(src) && !existsSync(dest)) {
      copyFileSync(src, dest);
      written.push(dest);
    }
  }
  // GH-442: .beads holds local workflow state; keep it owner-only.
  try {
    chmodSync(destBeads, 0o700);
  } catch {
    // best-effort hardening; never fail the stamp on a chmod error
  }
  return written;
}
