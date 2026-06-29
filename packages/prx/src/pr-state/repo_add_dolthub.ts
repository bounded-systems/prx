// GH-1703 — `prx repo add-dolthub`: wire a Dolthub remote on an already-
// registered, per-project beads workspace and persist the URL onto the
// repo's `.prx/repos/index.json` entry.
//
// Pure handler with DI seams (runner, bd subprocess wrappers, classify,
// origin reader, inventory I/O). The `cli.ts` executor wires the defaults.
// All decisions land in a single result arm; no exceptions for the happy
// paths.
//
// State-machine framing: this verb fulfils the `"add-dolthub"`
// migration_candidate already named in repo_audit.ts. No new XState events;
// the `repo` actor (planning/cli) owns add / audit / backfill and now this
// sibling. Idempotency invariant: a repo already wired at the candidate URL
// short-circuits to `already-wired` without invoking bd.

import { parseGitOrigin } from "../beads/hydrate.ts";
import {
  classifyBeadsWorkspace as defaultClassifyBeadsWorkspace,
  type BeadsWorkspaceMode,
} from "../beads/workspace_mode.ts";
import {
  DOLTHUB_REPO_NAME_PATTERN,
  defaultRepoRunner,
  loadRepoInventoryIndex as defaultLoadRepoInventoryIndex,
  writeRepoInventoryIndex as defaultWriteRepoInventoryIndex,
  type LocalRepo,
  type RepoInventoryConfig,
  type RepoRunner,
} from "./repos.ts";
import { locateRepo } from "./repo_locate.ts";
import { containerRepoRunner } from "../beads/container-runner.ts";

// ── options + deps ─────────────────────────────────────────────────────────

export type AddDolthubOptions = {
  /** Resolved by the executor via `loadRepoInventoryConfig(cwd)`. */
  config: RepoInventoryConfig;
  /** Optional positional slug; null → derive from cwd. */
  slug: string | null;
  /** `--dolthub-user` override; null → fall back to env-resolved default. */
  dolthubUserOverride: string | null;
  /** `--name` override; null → derive `<repo>` from origin. */
  nameOverride: string | null;
  /** True when `--no-push` was passed. */
  noPush: boolean;
  /** BEADS_DOLTHUB_OWNER fallback when `--dolthub-user` is absent. */
  dolthubOwnerDefault: string | null;
  /** Optional fallback cwd when `slug` is null (e.g. `process.cwd()`). */
  cwd?: string | undefined;
};

export type BdSubprocessResult = {
  stdout: string;
  stderr: string;
  status: number;
};

export type AddDolthubDeps = {
  runner?: RepoRunner;
  loadRepoInventoryIndex?: typeof defaultLoadRepoInventoryIndex;
  writeRepoInventoryIndex?: typeof defaultWriteRepoInventoryIndex;
  classify?: (repo: LocalRepo) => BeadsWorkspaceMode;
  getGitOrigin?: (repo: LocalRepo) => string | null;
  /** `bd dolt remote add origin <url>`. */
  bdDoltRemoteAdd?: (cwd: string, url: string) => BdSubprocessResult;
  /** `bd dolt push origin main`. */
  bdDoltPush?: (cwd: string, branch: "main") => BdSubprocessResult;
};

// ── result arms ────────────────────────────────────────────────────────────

export type AddDolthubRefusalReason =
  | "beads-state-none"
  | "beads-state-embedded"
  | "beads-state-ambiguous"
  | "beads-state-shared-server"
  | "no-origin"
  | "unparseable-origin"
  | "name-invalid"
  | "name-collision"
  | "drift"
  | "no-inventory"
  | "slug-not-found"
  | "no-worktree";

export type AddDolthubResult =
  | {
      kind: "wired";
      slug: string;
      url: string;
      pushed: boolean;
      chdirWarningSuppressed: boolean;
      bdStderr: string;
    }
  | { kind: "already-wired"; slug: string; url: string }
  | {
      kind: "refused";
      slug: string | null;
      reason: AddDolthubRefusalReason;
      detail: string;
    };

// ── error class ────────────────────────────────────────────────────────────

export class AddDolthubError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "AddDolthubError";
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

// GH-1696: bd's shared-server-mode flow successfully writes the SQL-side
// remote but emits a misleading "CLI remote failed; run cd '<...>' && dolt
// remote add" suggestion because the bd CLI half can't chdir into the worktree
// while a server is active. The SQL-side remote is sufficient for `bd dolt
// push/pull`. Strip the lines and surface a single structured note so the
// operator isn't told to run a manual fix that's already done.
const CHDIR_WARNING_PATTERNS: RegExp[] = [
  /^\s*Warning:\s+SQL remote added but CLI remote failed:.*$/m,
  /^\s*Run:\s+cd\s+'[^']*'\s+&&\s+dolt remote add\b.*$/m,
];

export function filterChdirWarning(stderr: string): { filtered: string; suppressed: boolean } {
  let filtered = stderr;
  let suppressed = false;
  for (const pat of CHDIR_WARNING_PATTERNS) {
    if (pat.test(filtered)) {
      suppressed = true;
      filtered = filtered.replace(pat, "");
    }
  }
  filtered = filtered.replace(/\n{3,}/g, "\n\n").trim();
  return { filtered, suppressed };
}

function resolvedRepoCwd(repo: LocalRepo): string | null {
  if (repo.mainWorktree) return repo.mainWorktree;
  if (repo.worktrees.length > 0) return repo.worktrees[0]!.path;
  return null;
}

// ── handler ────────────────────────────────────────────────────────────────

export function runRepoAddDolthub(
  opts: AddDolthubOptions,
  deps: AddDolthubDeps = {},
): AddDolthubResult {
  const runner = deps.runner ?? defaultRepoRunner;
  const loadIndex = deps.loadRepoInventoryIndex ?? defaultLoadRepoInventoryIndex;
  const writeIndex = deps.writeRepoInventoryIndex ?? defaultWriteRepoInventoryIndex;
  const classify =
    deps.classify ??
    ((repo) => {
      const cwd = resolvedRepoCwd(repo) ?? repo.commonDir;
      return defaultClassifyBeadsWorkspace(cwd);
    });
  const getGitOrigin =
    deps.getGitOrigin ??
    ((repo) => {
      const cwd = resolvedRepoCwd(repo) ?? repo.commonDir;
      const result = runner(["git", "-C", cwd, "remote", "get-url", "origin"], {
        check: false,
      });
      if (result.status !== 0) return null;
      const value = result.stdout.trim();
      return value.length > 0 ? value : null;
    });
  // prx-82b Slice 2c.3: `bd dolt remote add` (cred-free) runs in an ephemeral
  // beadsd-box container, not host bd. `dolt push` stays on host for now — it
  // needs DoltHub creds the container lacks; the sync agent owns recurring push,
  // and relocating the initial push wants a creds-mount design (later).
  const bdRemoteAdd = deps.bdDoltRemoteAdd ?? defaultBdDoltRemoteAdd(containerRepoRunner());
  const bdPush = deps.bdDoltPush ?? defaultBdDoltPush(runner);

  if (!opts.config.indexPath) {
    return {
      kind: "refused",
      slug: opts.slug,
      reason: "no-inventory",
      detail:
        "No `.prx/repos/index.json` resolved from this cwd. Run `prx repo add-dolthub` from a prx-managed checkout (or run `prx repo list` once to bootstrap the inventory).",
    };
  }
  const inventory = loadIndex(opts.config.indexPath);
  if (!inventory) {
    return {
      kind: "refused",
      slug: opts.slug,
      reason: "no-inventory",
      detail: `No repo inventory index at ${opts.config.indexPath}. Run \`prx repo list\` to populate it before wiring a Dolthub remote.`,
    };
  }

  const located = locateRepo(inventory, opts);
  if (located.kind === "not_found") {
    return {
      kind: "refused",
      slug: opts.slug,
      reason: "slug-not-found",
      detail: located.detail,
    };
  }
  const { repo, index } = located;

  const mode = classify(repo);
  if (mode.kind === "none") {
    return {
      kind: "refused",
      slug: repo.name,
      reason: "beads-state-none",
      detail: `${repo.name}: no .beads/ workspace. Run \`prx repo bootstrap ${repo.name}\` before wiring a Dolthub remote.`,
    };
  }
  if (mode.kind === "embedded") {
    return {
      kind: "refused",
      slug: repo.name,
      reason: "beads-state-embedded",
      detail: `${repo.name}: embedded-mode .beads/ workspace (GH-1691). Migrate to per-project layout before wiring a Dolthub remote.`,
    };
  }
  if (mode.kind === "ambiguous") {
    return {
      kind: "refused",
      slug: repo.name,
      reason: "beads-state-ambiguous",
      detail: `${repo.name}: ambiguous .beads/ shape — ${mode.details}. Repair before wiring a Dolthub remote.`,
    };
  }
  if (mode.kind === "shared_server") {
    return {
      kind: "refused",
      slug: repo.name,
      reason: "beads-state-shared-server",
      detail: `${repo.name}: shared-server beads mode keeps its Dolt store at ${mode.sharedDir} — no per-repo Dolthub wiring applies.`,
    };
  }

  const workspaceCwd = resolvedRepoCwd(repo);
  if (!workspaceCwd) {
    return {
      kind: "refused",
      slug: repo.name,
      reason: "no-worktree",
      detail: `${repo.name}: no attached worktree on the inventory entry. Run \`prx repo materialize ${repo.name}\` first so bd can target the .beads/.`,
    };
  }

  const originUrl = getGitOrigin(repo);
  if (!originUrl) {
    return {
      kind: "refused",
      slug: repo.name,
      reason: "no-origin",
      detail: `${repo.name}: no git origin set on the repo; cannot derive a default Dolthub URL. Pass --name to provide an explicit repo-name segment.`,
    };
  }
  const components = parseGitOrigin(originUrl);
  if (!components) {
    return {
      kind: "refused",
      slug: repo.name,
      reason: "unparseable-origin",
      detail: `${repo.name}: origin '${originUrl}' is not a recognized host URL. Pass --name to provide an explicit repo-name segment.`,
    };
  }

  const dolthubUser =
    opts.dolthubUserOverride?.trim() || opts.dolthubOwnerDefault?.trim() || components.owner;
  const repoName = opts.nameOverride?.trim() || components.repo;
  if (!DOLTHUB_REPO_NAME_PATTERN.test(repoName)) {
    return {
      kind: "refused",
      slug: repo.name,
      reason: "name-invalid",
      detail: `${repo.name}: Dolthub repo name '${repoName}' must be 3–32 chars and match ^[A-Za-z][A-Za-z0-9_-]*$. Pass --name to override.`,
    };
  }

  const candidateUrl = `https://doltremoteapi.dolthub.com/${dolthubUser}/${repoName}`;

  // Idempotency: same persisted URL → short-circuit, no bd subprocess.
  if (repo.dolt_remote === candidateUrl) {
    return { kind: "already-wired", slug: repo.name, url: candidateUrl };
  }
  // Drift: persisted URL exists but differs. Refuse with a `--name` hint so
  // the operator can reconcile rather than silently overwrite.
  if (repo.dolt_remote && repo.dolt_remote !== candidateUrl) {
    return {
      kind: "refused",
      slug: repo.name,
      reason: "drift",
      detail: `${repo.name}: already wired to ${repo.dolt_remote}, but the requested URL is ${candidateUrl}. Reconcile dolthub-side, or invoke with --name to match the existing remote.`,
    };
  }
  // Collision: another repo in the local inventory already owns this URL.
  // Operator passes `--name <distinct-value>` to disambiguate.
  for (const other of inventory.repos) {
    if (other.commonDir === repo.commonDir) continue;
    if (other.dolt_remote === candidateUrl) {
      return {
        kind: "refused",
        slug: repo.name,
        reason: "name-collision",
        detail: `${repo.name}: Dolthub URL ${candidateUrl} is already claimed by ${other.name} (${other.commonDir}). Pass --name <distinct-value> to disambiguate.`,
      };
    }
  }

  const remoteAddResult = bdRemoteAdd(workspaceCwd, candidateUrl);
  if (remoteAddResult.status !== 0) {
    throw new AddDolthubError(
      `${repo.name}: bd dolt remote add failed (exit ${remoteAddResult.status}): ${(remoteAddResult.stderr || remoteAddResult.stdout).trim()}`,
      "bd_dolt_remote_add_failed",
    );
  }
  const { filtered: remoteAddStderr, suppressed: chdirWarningSuppressed } = filterChdirWarning(
    remoteAddResult.stderr,
  );

  let pushed = false;
  let pushStderr = "";
  if (!opts.noPush) {
    const pushResult = bdPush(workspaceCwd, "main");
    if (pushResult.status !== 0) {
      throw new AddDolthubError(
        `${repo.name}: bd dolt push origin main failed (exit ${pushResult.status}): ${(pushResult.stderr || pushResult.stdout).trim()}`,
        "bd_dolt_push_failed",
      );
    }
    pushed = true;
    pushStderr = pushResult.stderr.trim();
  }

  inventory.repos[index] = { ...repo, dolt_remote: candidateUrl };
  writeIndex(opts.config.indexPath, inventory);

  const combinedStderr = [remoteAddStderr, pushStderr]
    .filter((s) => s.length > 0)
    .join("\n")
    .trim();
  return {
    kind: "wired",
    slug: repo.name,
    url: candidateUrl,
    pushed,
    chdirWarningSuppressed,
    bdStderr: combinedStderr,
  };
}

// ── helpers ────────────────────────────────────────────────────────────────

function defaultBdDoltRemoteAdd(
  runner: RepoRunner,
): (cwd: string, url: string) => BdSubprocessResult {
  return (cwd, url) => {
    const result = runner(["bd", "dolt", "remote", "add", "origin", url], {
      cwd,
      check: false,
    });
    return { stdout: result.stdout, stderr: result.stderr, status: result.status };
  };
}

function defaultBdDoltPush(
  runner: RepoRunner,
): (cwd: string, branch: "main") => BdSubprocessResult {
  return (cwd, branch) => {
    const result = runner(["bd", "dolt", "push", "origin", branch], {
      cwd,
      check: false,
    });
    return { stdout: result.stdout, stderr: result.stderr, status: result.status };
  };
}

// ── formatter ──────────────────────────────────────────────────────────────

export function formatRepoAddDolthub(result: AddDolthubResult, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  switch (result.kind) {
    case "wired": {
      const lines: string[] = [
        `wired ${result.slug} → ${result.url}`,
        `  push: ${result.pushed ? "done (bd dolt push origin main)" : "skipped (--no-push)"}`,
      ];
      if (result.chdirWarningSuppressed) {
        lines.push(
          "  note: bd CLI-half chdir warning suppressed (GH-1696); SQL-side remote is sufficient for bd dolt push/pull",
        );
      }
      if (result.bdStderr.length > 0) {
        lines.push("  bd stderr:");
        for (const line of result.bdStderr.split("\n")) {
          lines.push(`    ${line}`);
        }
      }
      return lines.join("\n");
    }
    case "already-wired":
      return `already-wired ${result.slug} → ${result.url}  (no bd subprocess invoked)`;
    case "refused":
      return `refused (${result.reason}): ${result.detail}`;
  }
}
