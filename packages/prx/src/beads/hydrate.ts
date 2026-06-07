/**
 * Beads hydration — derives a DoltHub remote URL from a repo's git origin
 * and clones the Dolt database into .beads/dolt/ when the worktree is fresh.
 *
 * Used by:
 *   - `prx beads hydrate` (CLI entry point and current source of truth)
 *   - Invoked from worktrunk's post-switch chain via nix/home-manager/worktrunk.nix
 *
 * Derivation convention (GH-1703):
 *   URL path segment 1: {dolt_user}  (who hosts the mirror)
 *   URL path segment 2: {repo}       (gh repo name, operator-friendly)
 *
 *   git@github.com:example-owner/example-repo.git
 *     → https://doltremoteapi.dolthub.com/example-owner/example-repo
 *
 * The org prefix is intentionally absent — {dolt_user} already disambiguates
 * ownership at the host. {dolt_user} and {gh_owner} are distinct axes:
 * {dolt_user} comes from BEADS_DOLTHUB_OWNER (set via home-manager
 * home.sessionVariables); when unset it falls back to {gh_owner}, correct
 * when a user mirrors only their own repos.
 *
 * Pre-GH-1703 the convention was `{dolt_user}/{host}__{gh_owner}__{repo}`.
 * Existing fleet remotes on that long shape need a one-time rename on
 * dolthub.com before their next hydrate (no backwards-compat fallback by
 * design; the persisted `LocalRepo.dolt_remote` is the source of truth for
 * wired repos, with this derivation as the fallback for unwired ones).
 *
 * Two-hop hydration & per-host mirror shape (GH-787 introduced the pattern,
 * GH-879 reshaped hop 2, GH-826 closed it out):
 *
 *   hop 1: `dolt clone <doltHubUrl>` → ~/.local/state/dolt/buffer/<owner>/<repo>/<db>
 *          — the per-host mirror; the slow (~10-min) DoltHub clone, done once
 *          per host and never re-run in place (`if (!existsSync(mirrorPath))`).
 *   hop 2: recursive copy (`copyTree` = fs.cpSync) of that mirror →
 *          <worktree>/.beads/dolt/<db> — NOT a `dolt clone file://<mirror>`.
 *
 * The mirror is a *full working Dolt repo* — deliberately NOT bare/compacted:
 *
 *   - dolt ≥1.86 rejects working repos as `file://` clone remotes ("remote at
 *     that url contains no Dolt data") because their NBS store carries a chunk
 *     journal the file:// reader cannot consume — which is why hop 2 copies the
 *     directory rather than re-cloning it. Do NOT "fix" hop 2 back to a
 *     `file://` clone (see GH-826 / GH-879).
 *   - The working-repo shape is *required*: it carries the
 *     `origin → doltremoteapi.dolthub.com/...` remote that `bd dolt push/pull`
 *     needs. A bare clone would drop that remote; copying the directory keeps
 *     it. (GH-826's "make the mirror file://-cloneable / bare" option was
 *     deliberately rejected for exactly this reason.)
 *   - The mirror is write-once and disposable — never the source of truth: it
 *     is created by a single `dolt clone`, then never re-served or
 *     `dolt fetch`/`pull`ed in place, so `fs.cpSync` of it is race-free, and
 *     `prx dolt reconcile` already tells operators to `rm -rf` it when its
 *     integrity is in doubt. If it ever becomes refreshable, the copy step must
 *     guard against torn journal reads.
 */

import { processEnv } from "@bounded-systems/env";
import { spawnCapture } from "@bounded-systems/proc";
import {
  chmodSync,
  cpSync,
  existsSync,
  readFileSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveMainWorktree as defaultResolveMainWorktree } from "./primary_worktree.ts";

export type OriginComponents = {
  host: string;
  owner: string;
  repo: string;
};

/**
 * Parse a git origin URL into host / owner / repo components. Returns null
 * when the URL shape isn't recognized (local paths, unusual schemes).
 *
 * Host dots are converted to dashes because DoltHub repo names forbid
 * dots. Host and path are lowercased to match DoltHub's normalization.
 */
export function parseGitOrigin(url: string): OriginComponents | null {
  let host = "";
  let path = "";

  // git@HOST:OWNER/REPO[.git]
  const sshMatch = url.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    host = sshMatch[1]!;
    path = sshMatch[2]!;
  }

  // ssh://git@HOST[:PORT]/OWNER/REPO[.git]
  if (!host) {
    const sshUrlMatch = url.match(/^ssh:\/\/git@([^/]+)\/(.+)$/);
    if (sshUrlMatch) {
      host = sshUrlMatch[1]!.replace(/:\d+$/, "");
      path = sshUrlMatch[2]!;
    }
  }

  // https://HOST/OWNER/REPO[.git] (also http://)
  if (!host) {
    const httpMatch = url.match(/^https?:\/\/([^/]+)\/(.+)$/);
    if (httpMatch) {
      host = httpMatch[1]!;
      path = httpMatch[2]!;
    }
  }

  if (!host || !path) return null;

  path = path.replace(/\.git$/, "").replace(/\/$/, "").toLowerCase();
  host = host.toLowerCase().replace(/\./g, "-");

  const slashIdx = path.indexOf("/");
  if (slashIdx < 0) return null;
  const owner = path.slice(0, slashIdx);
  const repo = path.slice(slashIdx + 1);
  if (!owner || !repo || repo.includes("/")) return null;

  return { host, owner, repo };
}

/**
 * Build the DoltHub remote URL for a given origin. The dolthubOwner argument
 * overrides the default (which is {gh_owner}) — set this from the
 * BEADS_DOLTHUB_OWNER env var at call sites.
 */
export function buildDoltRemoteUrl(
  components: OriginComponents,
  dolthubOwner?: string | null,
): string {
  const { owner, repo } = components;
  const dolt_user = dolthubOwner?.trim() || owner;
  return `https://doltremoteapi.dolthub.com/${dolt_user}/${repo}`;
}

/**
 * Build the per-host Dolt mirror path for a given origin / database. The
 * layout mirrors the git buffer root (`~/.local/state/git/buffer/<owner>/<repo>`)
 * from scripts/ensure_local_buffer_remote.sh, extended with `/<db>` because
 * dolt clone writes one database directory per clone.
 *
 * BEADS_DOLT_MIRROR_ROOT overrides the default root; otherwise it derives
 * from $HOME.
 *
 * This directory holds a *full working Dolt repo* (see the top-of-file
 * "per-host mirror shape" note): hydrate() copies it into worktrees with
 * fs.cpSync rather than `dolt clone file://`. Don't change that without
 * re-reading GH-826 / GH-879 — a bare / file://-cloneable layout drops the
 * `origin → DoltHub` remote that `bd dolt push/pull` depends on.
 */
export function buildDoltMirrorPath(
  components: OriginComponents,
  doltDb: string,
  env: NodeJS.ProcessEnv,
): string {
  const mirrorRoot =
    env.BEADS_DOLT_MIRROR_ROOT?.trim() ||
    `${env.HOME ?? ""}/.local/state/dolt/buffer`;
  return join(mirrorRoot, components.owner, components.repo, doltDb);
}

/**
 * Read the dolt_database name from .beads/metadata.json. Returns null if
 * the file is missing, unreadable, or doesn't have the expected field.
 */
export function readDoltDatabaseName(beadsDir: string): string | null {
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
 * GH-1691: legacy embedded-mode bd workspaces declare `dolt_mode: "embedded"`
 * in `.beads/metadata.json`. Per-project mode (GH-1471 canonical layout)
 * omits the field or sets it to `"per-project"`. Upstream `bd sql` refuses to
 * run in embedded mode (GH-1061 won't-do, relaxed only for per-project), so
 * the triage status path consults this before choosing between the GH-1573
 * scoped projection and the unscoped `bd list --all --json` fallback.
 *
 * Missing file, malformed JSON, or any other `dolt_mode` value returns
 * `false` (treat as per-project, the dominant case).
 */
export function isEmbeddedDoltMode(beadsDir: string): boolean {
  const metadataPath = join(beadsDir, "metadata.json");
  if (!existsSync(metadataPath)) return false;
  try {
    const raw = readFileSync(metadataPath, "utf8");
    const parsed = JSON.parse(raw) as { dolt_mode?: unknown };
    return parsed.dolt_mode === "embedded";
  } catch {
    return false;
  }
}

export type HydrateStatus =
  | "hydrated"       // successfully cloned from remote
  | "already-hydrated" // short-circuited — database already exists
  | "skipped-no-beads"
  | "skipped-no-metadata"
  | "skipped-no-origin"
  | "skipped-unparseable-origin"
  | "skipped-non-primary-worktree" // GH-653: feature worktree → use redirect
  | "dry-run"        // --dry-run requested, nothing executed
  | "clone-failed";

export type HydrateResult = {
  status: HydrateStatus;
  /** Derived DoltHub URL (present when derivation succeeded). */
  doltRemote: string | null;
  /** Database name from metadata.json (present when metadata was readable). */
  doltDatabase: string | null;
  /** Human-readable message suitable for logging. */
  message: string;
  /**
   * Process exit code the CLI should propagate.
   *
   * - `0` — `hydrated`, `already-hydrated`, `dry-run`, and every
   *   `skipped-*` short-circuit (no .beads, no metadata, missing or
   *   unparseable origin, GH-653 non-primary feature worktree).
   * - `1` — `clone-failed` (GH-657): callers need to distinguish a
   *   real clone failure from the healthy skip statuses so the
   *   worktrunk post-switch chain and other hook runners actually
   *   surface the problem instead of silently no-opping.
   */
  exitCode: number;
};

export type HydrateOptions = {
  /** Repository root. Defaults to process.cwd(). */
  cwd?: string | undefined;
  /** When true, compute the plan and return without running dolt clone. */
  dryRun?: boolean | undefined;
};

/**
 * Outcome of a single `dolt clone` subprocess. `stderr` is captured so
 * failure paths can surface the real dolt error (auth vs. "no Dolt data
 * at url" vs. network) instead of the wrapper guessing.
 */
export type DoltCloneResult = { exitCode: number; stderr: string };

export type HydrateDeps = {
  /** Resolve the git origin URL for `cwd`. Returns null when unset. */
  getGitOrigin: (cwd: string) => string | null;
  /** Stop the bd-managed Dolt server for `cwd`. Errors are ignored. */
  stopBdDoltServer: (cwd: string) => void;
  /** Run `dolt clone <url> <dest>`. Returns exit code + captured stderr. */
  doltClone: (url: string, dest: string) => DoltCloneResult;
  /** Environment (for BEADS_DOLTHUB_OWNER lookup). */
  env: NodeJS.ProcessEnv;
  /** Rename a filesystem entry. Defaults to fs.renameSync. */
  fsRename?: (from: string, to: string) => void;
  /** Recursively remove a path. Defaults to fs.rmSync(..., recursive, force). */
  rmTree?: (path: string) => void;
  /**
   * GH-879: recursively copy `src` to `dest`, preserving file contents.
   * Defaults to `fs.cpSync(src, dest, { recursive: true })`. Used for the
   * second hop (mirror → worktree dolt dir) because `dolt clone file://`
   * rejects working repos with chunk journals (dolt 1.86.x).
   */
  copyTree?: (src: string, dest: string) => void;
  /**
   * GH-653: resolve the repo's primary (main) worktree path. Returns null
   * when the cwd is not inside a git repo. When present and ≠ cwd, hydrate
   * short-circuits with `skipped-non-primary-worktree` so feature worktrees
   * never accumulate their own dolt data — they consume the primary's via
   * the `.beads/redirect` file written by `bootstrapBeads`. Defaults to the
   * shared helper; tests inject fixture paths.
   */
  resolveMainWorktree?: (cwd: string) => string | null;
};

const defaultDeps: HydrateDeps = {
  getGitOrigin: (cwd) => {
    const r = spawnCapture(["git", "remote", "get-url", "origin"], { cwd });
    if (r.status !== 0) return null;
    const out = r.stdout.trim();
    return out || null;
  },
  stopBdDoltServer: (cwd) => {
    const env = { ...processEnv() };
    delete env.BEADS_DIR;
    spawnCapture(["bd", "dolt", "stop"], { cwd, env });
  },
  doltClone: (url, dest) => {
    const r = spawnCapture(["dolt", "clone", url, dest]);
    return {
      exitCode: r.status ?? 1,
      stderr: r.stderr,
    };
  },
  env: processEnv(),
  fsRename: (from, to) => renameSync(from, to),
  rmTree: (path) => rmSync(path, { recursive: true, force: true }),
  copyTree: (src, dest) => cpSync(src, dest, { recursive: true }),
  resolveMainWorktree: (cwd) => defaultResolveMainWorktree(cwd),
};

/**
 * Format a `clone-failed` message: the wrapper line, then dolt's real
 * stderr when present. No canned auth hint — dolt's own output already
 * says "please run dolt login" when that's the actual cause.
 */
function formatCloneFailure(summary: string, stderr: string): string {
  const trimmed = stderr.trim();
  if (!trimmed) return summary;
  const indented = trimmed
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
  return `${summary}\ndolt stderr:\n${indented}`;
}

/**
 * Populate the per-host Dolt mirror by cloning `doltRemote` into a tmp
 * directory and atomically renaming it into place. Returns the doltClone
 * result (0 exit on success, nonzero + stderr on clone failure).
 *
 * POSIX `rename(2)` of a directory onto an existing non-empty directory
 * fails with ENOTEMPTY/EEXIST — we treat that as "another hydrate won the
 * race, reuse their mirror" rather than reaching for a lockfile.
 *
 * The mirror this populates is a full working Dolt repo cloned straight from
 * DoltHub — deliberately NOT bare. hydrate()'s second hop copies it
 * (`fs.cpSync`); it does NOT `dolt clone file://` it, because dolt ≥1.86
 * rejects working repos as file:// remotes. Don't pass `--bare` here or
 * switch the second hop to a file:// clone — see GH-826 / GH-879.
 */
export function ensureMirror(
  mirrorPath: string,
  doltRemote: string,
  deps: Required<Pick<HydrateDeps, "doltClone" | "fsRename" | "rmTree">>,
): DoltCloneResult {
  mkdirSync(dirname(mirrorPath), { recursive: true });
  const tmp = `${mirrorPath}.tmp-${process.pid}-${Date.now()}`;
  const cloneResult = deps.doltClone(doltRemote, tmp);
  if (cloneResult.exitCode !== 0) {
    deps.rmTree(tmp);
    return cloneResult;
  }
  try {
    deps.fsRename(tmp, mirrorPath);
  } catch (e) {
    deps.rmTree(tmp);
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOTEMPTY" || code === "EEXIST") return { exitCode: 0, stderr: "" };
    throw e;
  }
  return { exitCode: 0, stderr: "" };
}

/**
 * Hydrate a fresh worktree's Beads database. Safe to call on every
 * post-switch: short-circuits when the database directory already exists.
 */
export function hydrate(
  opts: HydrateOptions = {},
  deps: HydrateDeps = defaultDeps,
): HydrateResult {
  const cwd = opts.cwd ?? process.cwd();
  const beadsDir = join(cwd, ".beads");
  const doltParent = join(beadsDir, "dolt");

  if (!existsSync(beadsDir)) {
    return {
      status: "skipped-no-beads",
      doltRemote: null,
      doltDatabase: null,
      message: "beads: no .beads directory, skipping",
      exitCode: 0,
    };
  }

  // GH-653: feature worktrees must NEVER accumulate their own dolt data.
  // They consume the primary worktree's `.beads` via the `redirect` file
  // written by `bootstrapBeads`. Hydrating here would defeat that invariant
  // and produce a second Dolt server bound to the wrong data dir.
  const resolveMain = deps.resolveMainWorktree ?? defaultDeps.resolveMainWorktree!;
  const mainWorktree = resolveMain(cwd);
  if (mainWorktree && resolve(mainWorktree) !== resolve(cwd)) {
    return {
      status: "skipped-non-primary-worktree",
      doltRemote: null,
      doltDatabase: readDoltDatabaseName(beadsDir),
      message:
        `beads: ${cwd} is a feature worktree (primary=${mainWorktree}); ` +
        "skipping hydrate — bootstrap writes .beads/redirect instead",
      exitCode: 0,
    };
  }

  const doltDb = readDoltDatabaseName(beadsDir);
  if (!doltDb) {
    return {
      status: "skipped-no-metadata",
      doltRemote: null,
      doltDatabase: null,
      message: "beads: no readable .beads/metadata.json, skipping",
      exitCode: 0,
    };
  }

  const dbDir = join(doltParent, doltDb);
  if (existsSync(dbDir)) {
    return {
      status: "already-hydrated",
      doltRemote: null,
      doltDatabase: doltDb,
      message: `beads: ${doltDb} already hydrated, skipping`,
      exitCode: 0,
    };
  }

  const originUrl = deps.getGitOrigin(cwd);
  if (!originUrl) {
    return {
      status: "skipped-no-origin",
      doltRemote: null,
      doltDatabase: doltDb,
      message: "beads: no git origin, skipping",
      exitCode: 0,
    };
  }

  const components = parseGitOrigin(originUrl);
  if (!components) {
    return {
      status: "skipped-unparseable-origin",
      doltRemote: null,
      doltDatabase: doltDb,
      message: `beads: origin ${originUrl} is not a recognized host URL, skipping`,
      exitCode: 0,
    };
  }

  const doltRemote = buildDoltRemoteUrl(components, deps.env.BEADS_DOLTHUB_OWNER);
  const mirrorPath = buildDoltMirrorPath(components, doltDb, deps.env);

  if (opts.dryRun) {
    return {
      status: "dry-run",
      doltRemote,
      doltDatabase: doltDb,
      message:
        `beads: would clone ${doltRemote} → ${mirrorPath}; ` +
        `would copy ${mirrorPath} → .beads/dolt/${doltDb}`,
      exitCode: 0,
    };
  }

  // First hop: ensure the per-host mirror exists. On a cold host this is
  // the ~10-min DoltHub clone; on a warm host it's a no-op.
  if (!existsSync(mirrorPath)) {
    const mirrorResult = ensureMirror(mirrorPath, doltRemote, {
      doltClone: deps.doltClone,
      fsRename: deps.fsRename ?? defaultDeps.fsRename!,
      rmTree: deps.rmTree ?? defaultDeps.rmTree!,
    });
    if (mirrorResult.exitCode !== 0) {
      return {
        status: "clone-failed",
        doltRemote,
        doltDatabase: doltDb,
        message: formatCloneFailure(
          `beads: mirror clone failed for ${doltRemote}`,
          mirrorResult.stderr,
        ),
        exitCode: 1,
      };
    }
  }

  // bd auto-starts a Dolt server pointing at .beads/dolt/ on demand. If
  // one is running it holds the data directory exclusively and the clone
  // below will fail. Stop it first; the next bd call will auto-start a
  // fresh server pointing at the newly-cloned data.
  deps.stopBdDoltServer(cwd);

  mkdirSync(doltParent, { recursive: true });
  // GH-442: harden .beads to owner-only. mkdirSync honours the umask
  // (typically 0755 on macOS), so chmod explicitly. Idempotent.
  chmodSync(beadsDir, 0o700);

  // Second hop: populate the worktree's dolt dir from the local mirror.
  // GH-879: previously this used `dolt clone file://<mirror>`, but dolt
  // 1.86.x rejects working repos as file:// remotes ("clone failed; remote
  // at that url contains no Dolt data") because their NBS store contains a
  // chunk journal that the file:// reader cannot consume. The mirror was
  // populated by a real `dolt clone <doltHubUrl>` (first hop) and is a
  // fully-functional working repo with its origin pointing at DoltHub —
  // copying it byte-for-byte yields a worktree dolt dir that supports
  // every bd operation (sql, log, push, pull) the same as a clone would.
  // This also avoids the cold-host cost of round-tripping through dolt's
  // clone protocol on every fresh worktree. See the top-of-file "per-host
  // mirror shape" note and GH-826 (the close-out + the rejected bare-mirror
  // option) before reverting this to a `file://` clone.
  const copyTree = deps.copyTree ?? defaultDeps.copyTree!;
  try {
    copyTree(mirrorPath, dbDir);
  } catch (e) {
    const stderr = e instanceof Error ? e.message : String(e);
    return {
      status: "clone-failed",
      doltRemote,
      doltDatabase: doltDb,
      message: formatCloneFailure(
        `beads: worktree copy failed from ${mirrorPath}`,
        stderr,
      ),
      exitCode: 1,
    };
  }

  return {
    status: "hydrated",
    doltRemote,
    doltDatabase: doltDb,
    message: `beads: hydrated ${doltDb} from ${doltRemote} (via ${mirrorPath})`,
    exitCode: 0,
  };
}

export function formatHydrateResult(result: HydrateResult, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  return result.message;
}
