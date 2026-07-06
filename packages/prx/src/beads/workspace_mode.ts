// GH-1684 — `.beads/` disk-shape classifier. A primitive that operator-session
// entry points (and, later, bd-safe) consume to give the operator a precise
// hint *before* dispatching into a beads-aware verb.
//
// No coupling to the bd CLI: this reads only the `.beads/` subtree on disk
// (plus, for shared-server detection, the canonical shared-server root under
// $HOME). Four real arms plus an `"ambiguous"` escape hatch:
//   - `none`           → no `.beads/` at all (repo doesn't ship beads metadata)
//   - `per_project`    → `.beads/dolt/` exists (canonical GH-1471 layout)
//   - `embedded`       → `.beads/embeddeddolt/<ws>/.dolt` exists (legacy GH-1061)
//   - `shared_server`  → `.beads/metadata.json` declares `dolt_mode: "server"`
//                        AND `~/.beads/shared-server/dolt/<db>/` exists
//                        (GH-493 / GH-1701)
//   - `ambiguous`      → `.beads/` present but no recognized shape
//
// `beadsModeHint()` returns the operator-facing CliError text for non-ready
// modes; it returns `null` for per-project and shared-server (both ready).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homeDir } from "@bounded-systems/host";
import { join } from "node:path";

import { isCaptureFailure, type SpawnCaptureFn } from "@bounded-systems/proc";

import { bdSpawnCapture } from "../beadsd/bd-command-runner.ts";
import { resolveGitCommonDir } from "./git_common_dir.ts";

export type BeadsWorkspaceMode =
  | { kind: "none" }
  | { kind: "embedded"; doltDir: string }
  | { kind: "per_project"; doltDir: string }
  | { kind: "shared_server"; sharedDir: string }
  | { kind: "ambiguous"; details: string };

export function classifyBeadsWorkspace(
  cwd: string,
  opts: { homeDir?: string } = {},
): BeadsWorkspaceMode {
  const beadsDir = join(cwd, ".beads");
  if (!existsSync(beadsDir)) {
    return { kind: "none" };
  }

  // GH-1701: shared-server mode keeps the dolt store outside the worktree
  // (~/.beads/shared-server/dolt/<db>/), so it must be detected via
  // metadata.json before the per-project / embedded disk-shape ladders run.
  const metadata = readBeadsMetadata(beadsDir);
  if (metadata.dolt_mode === "server" && metadata.dolt_database) {
    const home = opts.homeDir ?? homeDir();
    const sharedDir = join(home, ".beads", "shared-server", "dolt", metadata.dolt_database);
    if (existsSync(sharedDir) && isDirectory(sharedDir)) {
      return { kind: "shared_server", sharedDir };
    }
  }

  const perProjectDolt = join(beadsDir, "dolt");
  if (existsSync(perProjectDolt) && isDirectory(perProjectDolt)) {
    return { kind: "per_project", doltDir: perProjectDolt };
  }

  const embeddedRoot = join(beadsDir, "embeddeddolt");
  if (existsSync(embeddedRoot) && isDirectory(embeddedRoot)) {
    const entries = safeReaddir(embeddedRoot);
    for (const entry of entries) {
      const candidate = join(embeddedRoot, entry, ".dolt");
      if (existsSync(candidate) && isDirectory(candidate)) {
        return { kind: "embedded", doltDir: candidate };
      }
    }
    return {
      kind: "ambiguous",
      details: `.beads/embeddeddolt/ has no <workspace>/.dolt subtree`,
    };
  }

  return {
    kind: "ambiguous",
    details: `.beads/ has neither dolt/ nor embeddeddolt/<ws>/.dolt`,
  };
}

/**
 * Classify `.beads/` for a repo, falling back to the git-common-dir when the
 * worktree `cwd` itself has none. For this ecosystem's usual bare-repo +
 * linked-worktree layout, `bd init` places `.beads/` at the common-dir (one
 * shared store per repo, not per worktree) rather than at the worktree cwd —
 * confirmed live via `prx repo bootstrap` on a bare+worktree repo. Plain
 * `classifyBeadsWorkspace(cwd)` alone reports `none` in that case even
 * though a real workspace exists one level up; this is the fallback callers
 * (`repo_bootstrap.ts`, `repo_add_dolthub.ts`) should use instead.
 */
export function classifyBeadsWorkspaceForRepo(
  cwd: string,
  opts: { homeDir?: string; resolveCommonDir?: (cwd: string) => string | undefined } = {},
): BeadsWorkspaceMode {
  const primary = classifyBeadsWorkspace(cwd, opts);
  if (primary.kind !== "none") return primary;
  const resolveCommonDir = opts.resolveCommonDir ?? resolveGitCommonDir;
  const commonDir = resolveCommonDir(cwd);
  if (!commonDir) return primary;
  return classifyBeadsWorkspace(commonDir, opts);
}

export function beadsModeHint(mode: BeadsWorkspaceMode, slug: string): string | null {
  switch (mode.kind) {
    case "per_project":
    case "shared_server":
      return null;
    case "none":
      return `repo "${slug}" does not ship beads metadata; operator-session verbs require a beads-tracked repo. See GH-493 for the bootstrap roadmap.`;
    case "embedded":
      return `repo "${slug}" is in legacy embedded mode (.beads/embeddeddolt/...). Migrate to per-project mode (GH-1471) before running triage session — bd-safe blocks bd sql in embedded mode (GH-1061).`;
    case "ambiguous":
      return `repo "${slug}" has .beads/ but neither dolt/ nor embeddeddolt/ — run \`prx repo refresh ${slug}\` to hydrate.`;
  }
}

export type BeadsMetadata = {
  dolt_mode: string | null;
  dolt_database: string | null;
};

export function readBeadsMetadata(beadsDir: string): BeadsMetadata {
  const metadataPath = join(beadsDir, "metadata.json");
  if (!existsSync(metadataPath)) {
    return { dolt_mode: null, dolt_database: null };
  }
  try {
    const raw = readFileSync(metadataPath, "utf8");
    const parsed = JSON.parse(raw) as {
      dolt_mode?: unknown;
      dolt_database?: unknown;
    };
    return {
      dolt_mode: typeof parsed.dolt_mode === "string" && parsed.dolt_mode ? parsed.dolt_mode : null,
      dolt_database:
        typeof parsed.dolt_database === "string" && parsed.dolt_database
          ? parsed.dolt_database
          : null,
    };
  } catch {
    return { dolt_mode: null, dolt_database: null };
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

// GH-1700: liveness probe for `prx repo gc`. Returns true iff the shared-server
// dolt store for this workspace is reachable AND has ≥1 issue row. Shells
// `bd list --json --limit 1` from `cwd` (bd auto-detects shared-server from
// `.beads/metadata.json`); `bd sql` is intentionally avoided per GH-1061.
export function probeSharedServerHasIssues(
  cwd: string,
  deps: { spawn?: SpawnCaptureFn } = {},
): boolean {
  const spawn = deps.spawn ?? bdSpawnCapture;
  const result = spawn(["bd", "list", "--json", "--limit", "1"], { cwd });
  if (isCaptureFailure(result)) return false;
  const trimmed = result.stdout.trim();
  if (trimmed.length === 0) return false;
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.length > 0;
    if (parsed && typeof parsed === "object") {
      const issues = (parsed as { issues?: unknown }).issues;
      if (Array.isArray(issues)) return issues.length > 0;
      const items = (parsed as { items?: unknown }).items;
      if (Array.isArray(items)) return items.length > 0;
    }
    return false;
  } catch {
    return false;
  }
}
