// GH-1704 — `prx repo bootstrap`: bootstrap a fresh per-project `.beads/`
// workspace on a registered, beads-less repo, then auto-chain
// `prx repo add-dolthub` (GH-1703) to wire the Dolthub remote. Fills the
// `migration_candidate=bootstrap` slot declared at `repo_audit.ts:33-39`.
//
// State-machine framing:
//   { beads_state: "none", migration_candidate: "bootstrap" }
//     │
//     ▼  prx repo bootstrap <slug>
//   { beads_state: "per-project", migration_candidate: "add-dolthub" }
//     │
//     ▼  auto-chain (non-fatal on refusal)
//   { beads_state: "per-project", migration_candidate: "none",
//     dolt_remote: "https://doltremoteapi.dolthub.com/<u>/<r>" }
//
// Two operator-visible flow modes:
//   --stealth        (default) — `bd init --stealth` only; no upstream
//                                commit / push / PR.
//   --ship-metadata           — commit `.beads/metadata.json` on a side branch
//                                `bootstrap/<slug>-beads-metadata`, push, open
//                                a draft PR. Protected-main check is a hard
//                                gate (operator likely intended `--stealth`
//                                otherwise).
//
// `bd init` is intentionally blocked from `src/tools/bd.ts:execBd`'s general
// allowlist; access lives in a dedicated `BdInitRunner` seam, parallel to
// `BdMigrateRunner` (GH-1706).
//
// All FS / shell / subprocess work flows through DI seams so tests can drive
// every arm without spawning real binaries.
//
// GH-1750 — bd v1.0.3 refuses `bd init` whenever it finds an embedded dolt
// store anywhere under `${HOME}/.local/share/beads-home/embeddeddolt/`, even
// when cwd is a fresh, beads-less repo with a distinct `--prefix`. This
// wedges bootstrap on every operator who still has a legacy embedded dolt
// store in their HOME. The verb sidesteps it by spawning `bd init` with
// `HOME` pointed at a fresh tempdir (silent, idempotent, non-destructive);
// the workaround retires by flipping `homeOverride: null` once bd-upstream
// lands a discovery fix. Per-step `BD_BOOTSTRAP_*` events parallel the
// `BD_MIGRATION_*` family so audit NDJSON consumers join both verbs the
// same way.

import { mkdirSync, rmSync } from "node:fs";
import { homeDir } from "@bounded-systems/host";
import { join } from "node:path";

import { runBdInit } from "../beads/init.ts";
import { defaultBdInitRunner, type BdInitRunner } from "../beads/init_runner.ts";
import { isCaptureFailure } from "@bounded-systems/proc";
import {
  classifyBeadsWorkspace as defaultClassifyBeadsWorkspace,
  type BeadsWorkspaceMode,
} from "../beads/workspace_mode.ts";
import { recordEvent as defaultRecordEvent } from "../machine/record_event.ts";
import {
  runRepoAddDolthub as defaultRunRepoAddDolthub,
  type AddDolthubDeps,
  type AddDolthubRefusalReason,
  type AddDolthubResult,
} from "./repo_add_dolthub.ts";
import { locateRepo } from "./repo_locate.ts";
import {
  defaultRepoRunner,
  loadRepoInventoryIndex as defaultLoadRepoInventoryIndex,
  writeRepoInventoryIndex as defaultWriteRepoInventoryIndex,
  WORKSPACE_PREFIX_PATTERN,
  type LocalRepo,
  type RepoInventoryConfig,
  type RepoRunner,
} from "./repos.ts";

// ── options + deps ─────────────────────────────────────────────────────────

export type RepoBootstrapOptions = {
  /** Resolved by the executor via `loadRepoInventoryConfig(cwd)`. */
  config: RepoInventoryConfig;
  /** Optional positional slug; null → derive from cwd. */
  slug: string | null;
  /** `--prefix` override; null → derive from slug. */
  prefixOverride: string | null;
  /**
   * `--ship-metadata` flow toggle. When `true`, after the local `bd init`
   * step the verb opens a draft PR against the protected main branch with
   * `.beads/metadata.json` committed on a side branch. When `false`
   * (`--stealth`, the default), nothing leaves the workspace.
   */
  shipMetadata: boolean;
  /** Fallback cwd when `slug` is null (e.g. `process.cwd()`). */
  cwd?: string | undefined;
};

export type BootstrapRecordEvent = (
  event: BootstrapEventName,
  opts?: { repo?: string; details?: Record<string, unknown> },
) => void;

export type RepoBootstrapDeps = {
  runner?: RepoRunner;
  loadRepoInventoryIndex?: typeof defaultLoadRepoInventoryIndex;
  writeRepoInventoryIndex?: typeof defaultWriteRepoInventoryIndex;
  classify?: (repo: LocalRepo) => BeadsWorkspaceMode;
  /** `bd init` runner — see `src/beads/init_runner.ts`. */
  bdInitRunner?: BdInitRunner;
  /** Probe whether `main` is protected on the upstream repo. */
  isMainProtected?: (repo: LocalRepo) => boolean;
  /** `git status --porcelain` parsed to clean/dirty. */
  gitStatusClean?: (cwd: string) => boolean;
  /** Auto-chain `runRepoAddDolthub` (non-fatal). */
  runAddDolthub?: typeof defaultRunRepoAddDolthub;
  /** Deps forwarded into the auto-chain so tests can stub bd/git/gh there too. */
  addDolthubDeps?: AddDolthubDeps;
  /** BEADS_DOLTHUB_OWNER fallback to forward into the auto-chain. */
  dolthubOwnerDefault?: string | null;
  /**
   * GH-1750 — factory for the per-call tempdir whose path becomes `HOME` for
   * the `bd init` subprocess. Default mints
   * `~/.local/state/prx/bd-init/<slug>-<iso-ts>/`. Tests inject a known path.
   */
  tempHomeFactory?: (slug: string, now: Date) => string;
  /**
   * GH-1750 — probe for the legacy `${HOME}/.local/share/beads-home/
   * embeddeddolt/<ws>/.dolt` shape. Documentary only (drives the
   * `BD_BOOTSTRAP_LEGACY_HOME_DETECTED` emit); HOME isolation runs
   * unconditionally regardless. Default reuses `classifyBeadsWorkspace`'s
   * embedded-mode arm against `${HOME}/.local/share/beads-home/`.
   */
  legacyHomeProbe?: (homeDir: string) => boolean;
  /** Clock override (tests pin `now`). */
  now?: () => Date;
  /** Audit event sink — defaults to `recordEvent` (writes daily NDJSON). */
  recordEvent?: BootstrapRecordEvent;
};

// ── result arms ────────────────────────────────────────────────────────────

export type BootstrapRefusalReason =
  | "no-inventory"
  | "slug-not-found"
  | "no-worktree"
  | "beads-already-present"
  | "prefix-invalid"
  | "protected-branch-no-pr"
  | "git-dirty"
  // GH-1750: HOME-isolation didn't unstick bd init — the upstream refusal
  // gate is wider than the embedded-home probe handles, or bd's discovery
  // logic changed shape. Falls out of the `bootstrapped` arm into a
  // structured refusal carrying the tempHome path for forensic inspection.
  | "bd-init-legacy-home-blocks-init"
  // GH-2017: bd's "Found existing Dolt database" stderr ALSO appears when bd
  // auto-discovers a per-project .beads/dolt in cwd or a parent. The
  // legacy-HOME `mv` workaround is wrong (and destructive) for this case;
  // distinguish via the "This workspace is already initialized" follow-up.
  | "bd-init-workspace-already-initialized";

export const BOOTSTRAP_EVENT_NAMES = [
  "BD_BOOTSTRAP_STARTED",
  "BD_BOOTSTRAP_LEGACY_HOME_DETECTED",
  "BD_BOOTSTRAP_LEGACY_HOME_ISOLATED",
  "BD_BOOTSTRAP_INIT_COMPLETED",
  "BD_BOOTSTRAP_AUTO_PUSH_DISABLED",
  "BD_BOOTSTRAP_AUTO_PUSH_DISABLE_FAILED",
  "BD_BOOTSTRAP_INDEX_UPDATED",
  "BD_BOOTSTRAP_COMPLETED",
  "BD_BOOTSTRAP_FAILED",
] as const;
export type BootstrapEventName = (typeof BOOTSTRAP_EVENT_NAMES)[number];

export type RepoBootstrapDolthubOutcome =
  | { wired: true; url: string }
  | { skipped: true; reason: AddDolthubRefusalReason };

export type RepoBootstrapResult =
  | {
      kind: "bootstrapped";
      slug: string;
      prefix: string;
      doltDir: string | null;
      shipped: boolean;
      pr?: { url: string; number: number };
      dolthub: RepoBootstrapDolthubOutcome | null;
      /**
       * GH-1750 — ordered list of `BD_BOOTSTRAP_*` events emitted during
       * this call. Mirrors `migrateAppliedSchema.events` so callers can
       * introspect without re-reading audit NDJSON.
       */
      events: BootstrapEventName[];
    }
  | {
      kind: "already-bootstrapped";
      slug: string;
      prefix: string;
      doltDir: string | null;
    }
  | {
      kind: "refused";
      slug: string | null;
      reason: BootstrapRefusalReason;
      detail: string;
    };

// ── error class ────────────────────────────────────────────────────────────

export class RepoBootstrapError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "RepoBootstrapError";
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function resolvedRepoCwd(repo: LocalRepo): string | null {
  if (repo.mainWorktree) return repo.mainWorktree;
  if (repo.worktrees.length > 0) return repo.worktrees[0]!.path;
  return null;
}

function defaultGitStatusClean(runner: RepoRunner): (cwd: string) => boolean {
  return (cwd) => {
    const result = runner(["git", "-C", cwd, "status", "--porcelain"], {
      check: false,
    });
    if (result.status !== 0) return false;
    return result.stdout.trim().length === 0;
  };
}

function defaultIsMainProtected(runner: RepoRunner): (repo: LocalRepo) => boolean {
  return (repo) => {
    const nameWithOwner = repo.primaryRemote?.githubRepo;
    if (!nameWithOwner) return false;
    const result = runner(["gh", "api", `repos/${nameWithOwner}/branches/main/protection`], {
      check: false,
    });
    return result.status === 0;
  };
}

function doltDirFromMode(mode: BeadsWorkspaceMode): string | null {
  return mode.kind === "per_project" ? mode.doltDir : null;
}

// GH-1750 — bd v1.0.3 walks `${HOME}/.local/share/beads-home/` and refuses
// `bd init` if it finds an embedded dolt store there, regardless of cwd or
// `--prefix`. The default probe reuses `classifyBeadsWorkspace` against
// that directory (its embedded-mode arm scans `.beads/embeddeddolt/<ws>/
// .dolt`); the legacy beads-home layout matches the same shape, so this
// reuses the production classifier rather than duplicating the
// readdir+stat ladder.
function defaultLegacyHomeProbe(homeDir: string): boolean {
  const beadsHome = join(homeDir, ".local", "share", "beads-home");
  const mode = defaultClassifyBeadsWorkspace(beadsHome);
  return mode.kind === "embedded";
}

function defaultTempHomeFactory(slug: string, now: Date): string {
  // Filesystem-safe ISO (drop ms + colons), parallel to migrate.ts's
  // `~/.local/state/prx/migrations/<slug>-<ts>/` backup sink. Survives
  // reboots (NOT `/tmp`) so a forensic operator can still inspect a
  // failed-arm tempHome the next day.
  const stamp = now
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/:/g, "-");
  const dir = join(homeDir(), ".local", "state", "prx", "bd-init", `${slug}-${stamp}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── handler ────────────────────────────────────────────────────────────────

export function runRepoBootstrap(
  opts: RepoBootstrapOptions,
  deps: RepoBootstrapDeps = {},
): RepoBootstrapResult {
  const runner = deps.runner ?? defaultRepoRunner;
  const loadIndex = deps.loadRepoInventoryIndex ?? defaultLoadRepoInventoryIndex;
  const writeIndex = deps.writeRepoInventoryIndex ?? defaultWriteRepoInventoryIndex;
  const classify =
    deps.classify ??
    ((repo) => {
      const cwd = resolvedRepoCwd(repo) ?? repo.commonDir;
      return defaultClassifyBeadsWorkspace(cwd);
    });
  const bdInitRunner: BdInitRunner = deps.bdInitRunner ?? defaultBdInitRunner;
  const isMainProtected = deps.isMainProtected ?? defaultIsMainProtected(runner);
  const gitStatusClean = deps.gitStatusClean ?? defaultGitStatusClean(runner);
  const runAddDolthub = deps.runAddDolthub ?? defaultRunRepoAddDolthub;
  const now = deps.now ?? (() => new Date());
  const tempHomeFactory = deps.tempHomeFactory ?? defaultTempHomeFactory;
  const legacyHomeProbe = deps.legacyHomeProbe ?? defaultLegacyHomeProbe;
  const recordEvent: BootstrapRecordEvent =
    deps.recordEvent ??
    ((event, recordOpts) =>
      defaultRecordEvent(event, {
        ...(recordOpts?.repo ? { repo: recordOpts.repo } : {}),
        ...(recordOpts?.details ? { details: recordOpts.details } : {}),
        now,
      }));

  // 1. inventory load.
  if (!opts.config.indexPath) {
    return {
      kind: "refused",
      slug: opts.slug,
      reason: "no-inventory",
      detail:
        "No `.prx/repos/index.json` resolved from this cwd. Run `prx repo bootstrap` from a prx-managed checkout (or run `prx repo list` once to bootstrap the inventory).",
    };
  }
  const inventory = loadIndex(opts.config.indexPath);
  if (!inventory) {
    return {
      kind: "refused",
      slug: opts.slug,
      reason: "no-inventory",
      detail: `No repo inventory index at ${opts.config.indexPath}. Run \`prx repo list\` to populate it before bootstrapping a beads workspace.`,
    };
  }

  // 2. locate repo.
  const located = locateRepo(inventory, { slug: opts.slug, cwd: opts.cwd });
  if (located.kind === "not_found") {
    return {
      kind: "refused",
      slug: opts.slug,
      reason: "slug-not-found",
      detail: located.detail,
    };
  }
  const { repo, index } = located;

  // 3. worktree presence.
  const workspaceCwd = resolvedRepoCwd(repo);
  if (!workspaceCwd) {
    return {
      kind: "refused",
      slug: repo.name,
      reason: "no-worktree",
      detail: `${repo.name}: no attached worktree on the inventory entry. Run \`prx repo materialize ${repo.name}\` first so bd can target the .beads/.`,
    };
  }

  // 4. derive + validate prefix.
  const prefix = opts.prefixOverride?.trim() || repo.name;
  if (!WORKSPACE_PREFIX_PATTERN.test(prefix)) {
    return {
      kind: "refused",
      slug: repo.name,
      reason: "prefix-invalid",
      detail: `${repo.name}: prefix '${prefix}' does not match ${WORKSPACE_PREFIX_PATTERN}. Pass --prefix <value> to override.`,
    };
  }

  // 5. classify + idempotency / already-present gates.
  const mode = classify(repo);
  if (mode.kind === "per_project" && repo.bd_workspace_prefix === prefix) {
    return {
      kind: "already-bootstrapped",
      slug: repo.name,
      prefix,
      doltDir: doltDirFromMode(mode),
    };
  }
  if (mode.kind !== "none") {
    return {
      kind: "refused",
      slug: repo.name,
      reason: "beads-already-present",
      detail: refusalDetailForExistingMode(repo.name, mode),
    };
  }

  // 6. --ship-metadata pre-flight: clean tree + protected main.
  if (opts.shipMetadata) {
    if (!gitStatusClean(workspaceCwd)) {
      return {
        kind: "refused",
        slug: repo.name,
        reason: "git-dirty",
        detail: `${repo.name}: working tree at ${workspaceCwd} is dirty; --ship-metadata requires a clean tree so only .beads/metadata.json lands in the commit.`,
      };
    }
    if (!isMainProtected(repo)) {
      return {
        kind: "refused",
        slug: repo.name,
        reason: "protected-branch-no-pr",
        detail: `${repo.name}: main is not protected on the upstream repo; --ship-metadata expects a protected main (operator likely intended --stealth).`,
      };
    }
  }

  // 7. bd init (per-project mode). Stealth flag suppresses the bd-managed
  // boilerplate (CLAUDE.md, README.md) unless `--ship-metadata` is active —
  // operators committing the bd files want the full scaffolding.
  //
  // GH-1750 — every `bd init` invocation runs with `HOME` pointed at a
  // fresh tempdir so bd's `${HOME}/.local/share/beads-home/embeddeddolt/`
  // discovery probe can't fire on a legacy embedded store. Isolation is
  // unconditional; the `BD_BOOTSTRAP_LEGACY_HOME_DETECTED` emit is
  // documentary only (so the audit row shows whether the workaround was
  // load-bearing on a given run).
  const emittedEvents: BootstrapEventName[] = [];
  const emit = (event: BootstrapEventName, details?: Record<string, unknown>) => {
    recordEvent(event, { repo: repo.name, ...(details ? { details } : {}) });
    emittedEvents.push(event);
  };

  emit("BD_BOOTSTRAP_STARTED", {
    slug: repo.name,
    prefix,
    shipMetadata: opts.shipMetadata,
  });

  if (legacyHomeProbe(homeDir())) {
    emit("BD_BOOTSTRAP_LEGACY_HOME_DETECTED", { homeDir: homeDir() });
  }

  const tempHome = tempHomeFactory(repo.name, now());
  emit("BD_BOOTSTRAP_LEGACY_HOME_ISOLATED", { tempHome });

  const initResult = runBdInit(
    {
      prefix,
      stealth: !opts.shipMetadata,
      cwd: workspaceCwd,
      homeOverride: tempHome,
    },
    bdInitRunner,
  );
  if (!initResult.ok) {
    const combined = (initResult.stderr || initResult.stdout).trim();
    const hasFoundExistingDolt = combined.includes("Found existing Dolt database");
    const isAlreadyInitialized = combined.includes("This workspace is already initialized");
    const isLegacyHome = hasFoundExistingDolt && !isAlreadyInitialized;
    emit("BD_BOOTSTRAP_FAILED", {
      legacyHomeStillBlocked: isLegacyHome,
      tempHome,
      status: initResult.status,
      detail: combined,
    });
    // Failure preserves the tempdir for forensic inspection (parallel to
    // `migrate.ts`'s backup-on-failure convention).
    if (hasFoundExistingDolt && isAlreadyInitialized) {
      return {
        kind: "refused",
        slug: repo.name,
        reason: "bd-init-workspace-already-initialized",
        detail:
          `${repo.name}: bd refused because a .beads/dolt workspace already exists at or above ${workspaceCwd}. ` +
          `Run \`bd info\` (in ${workspaceCwd}) to confirm the existing workspace, then ` +
          `\`prx repo backfill ${repo.name}\` to record its prefix in .prx/repos/index.json. ` +
          `Do NOT move ~/.local/share/beads-home — that won't help and may corrupt live bd state.`,
      };
    }
    if (isLegacyHome) {
      return {
        kind: "refused",
        slug: repo.name,
        reason: "bd-init-legacy-home-blocks-init",
        detail:
          `${repo.name}: bd init still refused with HOME isolated to ${tempHome}. ` +
          `Upstream fix tracked at gastownhall/beads. Manual workaround: ` +
          `mv ~/.local/share/beads-home ~/.local/share/beads-home.legacy.bak then re-run.`,
      };
    }
    throw new RepoBootstrapError(
      `${repo.name}: bd init failed (exit ${initResult.status}): ${combined}`,
      "bd_init_failed",
    );
  }
  emit("BD_BOOTSTRAP_INIT_COMPLETED");

  // GH-1935 — disable dolt auto-push so bd writes don't block on the 30s
  // timeout when the Hosted Dolt remote is unreachable (no creds, network
  // partition, etc.). Failed auto-pushes silently corrupt the resolver's
  // view of recent writes (2026-05-16 contamination incident). Operators
  // can re-enable via `bd config set dolt.auto-push true` per-repo if they
  // want Hosted Dolt replication. Non-fatal on failure.
  const autoPushResult = bdInitRunner(["bd", "config", "set", "dolt.auto-push", "false"], {
    cwd: workspaceCwd,
  });
  if (isCaptureFailure(autoPushResult)) {
    emit("BD_BOOTSTRAP_AUTO_PUSH_DISABLE_FAILED", {
      detail: (autoPushResult.stderr || autoPushResult.stdout || "").trim(),
    });
  } else {
    emit("BD_BOOTSTRAP_AUTO_PUSH_DISABLED");
  }

  // Success: tempHome served its purpose; sweep it.
  try {
    rmSync(tempHome, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup — a left-behind tempdir is harmless.
  }

  // 8. persist bd_workspace_prefix on the inventory entry.
  inventory.repos[index] = { ...repo, bd_workspace_prefix: prefix };
  writeIndex(opts.config.indexPath, inventory);
  emit("BD_BOOTSTRAP_INDEX_UPDATED", { prefix });

  // 9. ship-metadata flow — side branch + commit + push + draft PR.
  let pr: { url: string; number: number } | undefined;
  if (opts.shipMetadata) {
    const headBranch = `bootstrap/${repo.name}-beads-metadata`;
    runner(["git", "-C", workspaceCwd, "checkout", "-b", headBranch]);
    runner(["git", "-C", workspaceCwd, "add", ".beads/metadata.json"]);
    runner([
      "git",
      "-C",
      workspaceCwd,
      "commit",
      "-m",
      `chore(beads): bootstrap ${repo.name} metadata`,
    ]);
    runner(["git", "-C", workspaceCwd, "push", "-u", "origin", headBranch]);
    const createResult = runner(
      [
        "gh",
        "pr",
        "create",
        "--draft",
        "--base",
        "main",
        "--head",
        headBranch,
        "--title",
        `chore(beads): bootstrap ${repo.name} metadata`,
        "--body",
        "Generated by `prx repo bootstrap --ship-metadata` (GH-1704).",
      ],
      { cwd: workspaceCwd, check: false },
    );
    if (createResult.status !== 0) {
      throw new RepoBootstrapError(
        `${repo.name}: gh pr create failed: ${(createResult.stderr || createResult.stdout).trim()}`,
        "gh_pr_create_failed",
      );
    }
    pr = parseGhPrUrl(createResult.stdout);
  }

  // 10. auto-chain `prx repo add-dolthub` (non-fatal). add-dolthub accepts
  // per-project mode and wires `https://doltremoteapi.dolthub.com/<u>/<r>`;
  // refusals (no-origin, name-collision, name-invalid, drift) fold into
  // `dolthub: { skipped, reason }` so bootstrap stays the "bootstrapped" arm.
  const chainResult = runAddDolthub(
    {
      config: opts.config,
      slug: repo.name,
      dolthubUserOverride: null,
      nameOverride: null,
      noPush: false,
      dolthubOwnerDefault: deps.dolthubOwnerDefault ?? null,
      cwd: workspaceCwd,
    },
    deps.addDolthubDeps ?? {},
  );
  const dolthub = foldDolthubChain(chainResult);

  // Re-classify so the result's `doltDir` reflects the post-init layout.
  const postMode = classify({ ...repo, bd_workspace_prefix: prefix });

  emit("BD_BOOTSTRAP_COMPLETED", {
    prefix,
    doltDir: doltDirFromMode(postMode),
    shipped: opts.shipMetadata,
    ...(pr ? { prUrl: pr.url, prNumber: pr.number } : {}),
  });

  return {
    kind: "bootstrapped",
    slug: repo.name,
    prefix,
    doltDir: doltDirFromMode(postMode),
    shipped: opts.shipMetadata,
    ...(pr ? { pr } : {}),
    dolthub,
    events: emittedEvents,
  };
}

function refusalDetailForExistingMode(slug: string, mode: BeadsWorkspaceMode): string {
  switch (mode.kind) {
    case "embedded":
      return `${slug}: embedded-mode .beads/ workspace already present (GH-1691). Run \`prx beads migrate ${slug}\` to move to shared-server mode.`;
    case "per_project":
      return `${slug}: per-project .beads/ workspace already present at ${mode.doltDir}. Run \`prx repo audit ${slug}\` for the next-step recommendation.`;
    case "shared_server":
      return `${slug}: shared-server .beads/ workspace already present at ${mode.sharedDir}. Run \`prx repo audit ${slug}\` for the next-step recommendation.`;
    case "ambiguous":
      return `${slug}: ambiguous .beads/ shape — ${mode.details}. Repair manually before bootstrap.`;
    case "none":
      return `${slug}: classifier returned 'none' but the gate fired; this is a bug.`;
  }
}

function foldDolthubChain(result: AddDolthubResult): RepoBootstrapDolthubOutcome {
  switch (result.kind) {
    case "wired":
    case "already-wired":
      return { wired: true, url: result.url };
    case "refused":
      return { skipped: true, reason: result.reason };
  }
}

function parseGhPrUrl(stdout: string): { url: string; number: number } | undefined {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return undefined;
  // gh pr create prints the PR URL on the last non-empty line.
  const lines = trimmed
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const last = lines[lines.length - 1];
  if (!last) return undefined;
  const match = last.match(/\/pull\/(\d+)$/);
  if (!match) return { url: last, number: 0 };
  return { url: last, number: Number.parseInt(match[1]!, 10) };
}

// ── formatter ──────────────────────────────────────────────────────────────

export function formatRepoBootstrap(result: RepoBootstrapResult, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  switch (result.kind) {
    case "bootstrapped": {
      const lines: string[] = [
        `bootstrapped ${result.slug} [prefix=${result.prefix}]`,
        `  mode: per-project${result.doltDir ? ` (${result.doltDir})` : ""}`,
        `  ship-metadata: ${result.shipped ? "yes" : "stealth (no upstream commit)"}`,
      ];
      if (result.pr) {
        lines.push(`  pr: ${result.pr.url}`);
      }
      if (result.dolthub) {
        if ("wired" in result.dolthub) {
          lines.push(`  dolthub: wired → ${result.dolthub.url}`);
        } else {
          lines.push(`  dolthub: skipped (${result.dolthub.reason})`);
        }
      }
      return lines.join("\n");
    }
    case "already-bootstrapped":
      return `already-bootstrapped ${result.slug} [prefix=${result.prefix}]${result.doltDir ? ` → ${result.doltDir}` : ""}`;
    case "refused":
      return `refused (${result.reason}): ${result.detail}`;
  }
}
