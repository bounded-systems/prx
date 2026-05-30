// GH-1660 — `materializeBareRepo()` clone-or-fetch primitive.
//
// Idempotent verb that brings a registered bare repo on disk to "current".
// Three terminal arms selected from disk state:
//   - `cloned`   — barePath missing → `git clone --bare` + fetch refspec + fetch
//   - `fetched`  — barePath present but FETCH_HEAD older than TTL → `git fetch --all --prune`
//   - `noop`     — barePath present and FETCH_HEAD fresh
//
// Pure function: no event emission, no CLI deps. The caller (CLI handler in
// `cli.ts`, GH-1659 `repo_router`, GH-1662 §3a daemon) owns the
// `BARE_MATERIALIZED` audit row so each call site attributes its own
// `repo` / `workUnitId`. See ADR §7 (docs/spike/cross-repo-bd-routing.md).
//
// Invariants (informal; promoted to `invariantSpecs` when GH-1659 wires the
// consumer transition):
//   - I-Mat-2: `--dry-run` makes zero git subprocess calls and creates no
//              files. The caller still emits one row with `dryRun: true`.
//   - I-Mat-3: freshness signal is `mtime(<barePath>/FETCH_HEAD)`. No sidecar
//              cache file — `git fetch` updates FETCH_HEAD atomically.
//   - I-Mat-4: the repo inventory is read once at entry and not re-read
//              mid-tick (matches GH-1659 I-RR2).

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  defaultRepoRunner,
  findRepoBySlug,
  loadRepoInventoryConfig,
  loadRepoInventoryIndex,
  type LocalRepo,
  type RepoRefreshResult,
  type RepoRunner,
} from "./repos.ts";

export const DEFAULT_MATERIALIZE_TTL_SECONDS = 60;

export type MaterializeAction = "cloned" | "fetched" | "noop";

export type MaterializeResult = {
  /** Resolved canonical name from the inventory entry. */
  repo: string;
  /** Absolute path of the bare repo under `bareRoot`. */
  barePath: string;
  action: MaterializeAction;
  /**
   * `mtime(<barePath>/FETCH_HEAD)` in ms after the call. `null` when the
   * bare repo doesn't exist on disk after the call (only possible when
   * `dryRun: true` AND `action === "cloned"`).
   */
  lastFetchedAtMs: number | null;
  dryRun: boolean;
  /**
   * GH-1752: populated by the CLI handler when the bare leg succeeds and
   * the handler then composes `refreshLocalRepo` (mainx create + lazy
   * refspec upgrade + beads `.beads/` hydrate). Absent for direct callers
   * of {@link materializeBareRepo} (e.g. the `repo_router` daemon path
   * for GH-1662 §3a cross-repo bd sync), which keep the bare-only shape.
   */
  postMaterialize?: {
    mainxPath: string;
    mainxCreated: boolean;
    refspecUpgraded: boolean;
    refspecBefore: string[];
    refspecAfter: string[];
    beadsHydrate: RepoRefreshResult["beadsHydrate"];
  };
};

export type MaterializeErrorCode =
  | "name_not_in_index"
  | "no_index_file"
  | "no_primary_remote"
  | "bare_root_unresolved"
  | "ambiguous_name";

export class MaterializeError extends Error {
  public readonly code: MaterializeErrorCode;
  constructor(message: string, code: MaterializeErrorCode) {
    super(message);
    this.name = "MaterializeError";
    this.code = code;
  }
}

export type MaterializeOptions = {
  /** Repo slug — matched against `name` first, then `owner/name`. */
  name: string;
  cwd?: string | undefined;
  /**
   * TTL precedence: explicit arg > `prx.toml [wt] materialize_ttl_seconds`
   * > {@link DEFAULT_MATERIALIZE_TTL_SECONDS}.
   */
  ttlSeconds?: number | undefined;
  /** When true, computes the action arm but skips all git subprocesses. */
  dryRun?: boolean | undefined;
  /** Git seam — defaults to {@link defaultRepoRunner}. */
  runner?: RepoRunner | undefined;
  /** Clock seam for tests. */
  now?: () => number;
};

export function materializeBareRepo(opts: MaterializeOptions): MaterializeResult {
  const cwd = opts.cwd ?? process.cwd();
  const runner = opts.runner ?? defaultRepoRunner;
  const now = opts.now ?? (() => Date.now());
  const dryRun = opts.dryRun === true;

  const inventoryConfig = loadRepoInventoryConfig(cwd, runner);
  if (!inventoryConfig.bareRoot) {
    throw new MaterializeError(
      `Cannot resolve bareRoot from prx config (cwd=${cwd}).`,
      "bare_root_unresolved",
    );
  }
  if (!inventoryConfig.indexPath) {
    throw new MaterializeError(
      `No prx repo inventory index path resolved (cwd=${cwd}).`,
      "no_index_file",
    );
  }

  const inventory = loadRepoInventoryIndex(inventoryConfig.indexPath);
  if (!inventory) {
    throw new MaterializeError(
      `No repo inventory index file at ${inventoryConfig.indexPath} — run \`prx repo add\` first.`,
      "no_index_file",
    );
  }

  const lookup = findRepoBySlug(inventory, opts.name);
  if (!lookup.ok) {
    if (lookup.error.kind === "ambiguous") {
      throw new MaterializeError(
        `Repo slug \`${opts.name}\` is ambiguous: ${lookup.error.candidates.join(", ")}`,
        "ambiguous_name",
      );
    }
    throw new MaterializeError(
      `Repo slug \`${opts.name}\` is not in the inventory at ${inventoryConfig.indexPath}.`,
      "name_not_in_index",
    );
  }

  const repo: LocalRepo = lookup.repo;
  const barePath = repo.commonDir;
  if (!barePath) {
    throw new MaterializeError(
      `Inventory entry for \`${opts.name}\` has no commonDir.`,
      "name_not_in_index",
    );
  }
  if (!repo.primaryRemote?.url) {
    throw new MaterializeError(
      `Inventory entry for \`${opts.name}\` has no primary remote URL.`,
      "no_primary_remote",
    );
  }
  const remoteUrl = repo.primaryRemote.url;

  const ttlSeconds = resolveTtlSeconds(
    opts.ttlSeconds,
    inventoryConfig.repoRoot,
  );

  const action = decideAction(barePath, ttlSeconds, now());

  if (dryRun) {
    return {
      repo: repo.name,
      barePath,
      action,
      lastFetchedAtMs: readFetchHeadMtime(barePath),
      dryRun: true,
    };
  }

  if (action === "cloned") {
    // Mirror addLocalRepo()'s three-step bare-clone sequence
    // (src/pr-state/repos.ts:1144-1160). Intentionally not extracted: the
    // shared shape is enforced by tests; addLocalRepo() does extra mainx +
    // workspace-prefix work irrelevant to this primitive.
    mkdirSync(dirname(barePath), { recursive: true });
    runner(["git", "clone", "--bare", remoteUrl, barePath]);
    runner([
      "git",
      "-C",
      barePath,
      "config",
      "--add",
      "remote.origin.fetch",
      "+refs/heads/*:refs/remotes/origin/*",
    ]);
    runner(["git", "-C", barePath, "fetch", "origin"]);
  } else if (action === "fetched") {
    runner(["git", "-C", barePath, "fetch", "--all", "--prune"]);
  }

  return {
    repo: repo.name,
    barePath,
    action,
    lastFetchedAtMs: readFetchHeadMtime(barePath),
    dryRun: false,
  };
}

function decideAction(
  barePath: string,
  ttlSeconds: number,
  nowMs: number,
): MaterializeAction {
  if (!existsSync(barePath)) {
    return "cloned";
  }
  const mtime = readFetchHeadMtime(barePath);
  if (mtime === null) {
    return "fetched";
  }
  const ageSeconds = (nowMs - mtime) / 1000;
  return ageSeconds < ttlSeconds ? "noop" : "fetched";
}

function readFetchHeadMtime(barePath: string): number | null {
  const fetchHeadPath = join(barePath, "FETCH_HEAD");
  if (!existsSync(fetchHeadPath)) {
    return null;
  }
  return statSync(fetchHeadPath).mtimeMs;
}

function resolveTtlSeconds(
  explicit: number | undefined,
  repoRoot: string | null,
): number {
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  if (repoRoot) {
    return loadMaterializeTtlSeconds(repoRoot);
  }
  return DEFAULT_MATERIALIZE_TTL_SECONDS;
}

/**
 * Read `prx.toml [wt] materialize_ttl_seconds`. Mirrors
 * `loadReadyTtlSeconds()` line-for-line — same minimal TOML scanner, same
 * fallback shape.
 */
export function loadMaterializeTtlSeconds(repoPath: string): number {
  const configPath = join(repoPath, "prx.toml");
  if (!existsSync(configPath)) return DEFAULT_MATERIALIZE_TTL_SECONDS;

  let section = "";
  for (const rawLine of readFileSync(configPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const sectionMatch = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1] ?? "";
      continue;
    }
    if (section !== "wt") continue;
    const keyMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!keyMatch || keyMatch[1] !== "materialize_ttl_seconds") continue;
    const raw = (keyMatch[2] ?? "").trim();
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }

  return DEFAULT_MATERIALIZE_TTL_SECONDS;
}
