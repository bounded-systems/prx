// `prx repo convert-to-bare --from-worktree <path>` — physically move a
// standard (non-bare) working copy's `.git` out to the canonical
// `~/.local/share/git/bare/...` location and recreate the workdir as a
// linked worktree, then register it via `adoptRepo`.
//
// Scope: only the case where no bare already exists at the target
// `repo_id` (Case A). If one does, this throws — reconciling two divergent
// histories under the same `repo_id` is a judgment call, not something to
// automate; see `RepoConvertError` code `bare_path_exists`.
//
// The workdir's branch/sha is captured *before* any mutation and the
// recreated worktree is checked out on that exact captured state — never
// `origin/<branch>` — so a stash created against it is guaranteed to pop
// cleanly (nothing else can move this repo's own refs mid-conversion, since
// every step here runs sequentially against the same local repo).

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  canonicalBarePathFromParsed,
  defaultRepoRunner,
  uniqueBackupPath,
  type RepoRunner,
} from "./repos.ts";
import { RepositoryStore } from "./registry_store.ts";
import { adoptRepo, inferRepoFromWorktree, type AdoptRepoResult } from "./repo_adopt.ts";

export class RepoConvertError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "RepoConvertError";
  }
}

export type RepoConvertPlan = {
  repoId: string;
  sourceGitDir: string;
  targetBarePath: string;
  worktreePath: string;
  branch: string | null;
  headSha: string;
  willStash: boolean;
  siblingWorktrees: string[];
};

export type RepoConvertResult =
  | { kind: "planned"; plan: RepoConvertPlan }
  | {
      kind: "converted";
      plan: RepoConvertPlan;
      stashed: boolean;
      repairedSiblings: string[];
      adopt: AdoptRepoResult;
    };

export type RepoConvertOptions = {
  worktreePath: string;
  bareRoot: string;
  store: RepositoryStore;
  runner?: RepoRunner;
  dryRun?: boolean;
  now?: () => Date;
};

type WorktreeEntry = {
  path: string;
  branch: string | null;
  detached: boolean;
  locked: string | null;
};

function parseWorktreeListPorcelain(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current?.path) {
        entries.push({
          path: current.path,
          branch: current.branch ?? null,
          detached: current.detached ?? false,
          locked: current.locked ?? null,
        });
      }
      current = { path: line.slice("worktree ".length).trim() };
    } else if (line.startsWith("branch ")) {
      if (current) current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      if (current) current.detached = true;
    } else if (line.startsWith("locked")) {
      if (current) current.locked = line.slice("locked".length).trim() || "(no reason given)";
    }
  }
  if (current?.path) {
    entries.push({
      path: current.path,
      branch: current.branch ?? null,
      detached: current.detached ?? false,
      locked: current.locked ?? null,
    });
  }
  return entries;
}

function listWorktrees(cwd: string, runner: RepoRunner): WorktreeEntry[] {
  const result = runner(["git", "worktree", "list", "--porcelain"], { cwd, check: false });
  if (result.status !== 0) {
    throw new RepoConvertError(
      `git worktree list failed in ${cwd}: ${(result.stderr || result.stdout).trim()}`,
      "worktree_list_failed",
    );
  }
  return parseWorktreeListPorcelain(result.stdout);
}

function resolveGitCommonDir(path: string, runner: RepoRunner): string | null {
  const result = runner(["git", "rev-parse", "--git-common-dir"], { cwd: path, check: false });
  if (result.status !== 0) return null;
  const raw = result.stdout.trim();
  return raw ? resolve(path, raw) : null;
}

function buildPlan(
  absWorktree: string,
  bareRoot: string,
  runner: RepoRunner,
): { plan: RepoConvertPlan; entries: WorktreeEntry[] } {
  const gitPath = resolve(absWorktree, ".git");
  if (!existsSync(gitPath) || !statSync(gitPath).isDirectory()) {
    throw new RepoConvertError(
      `${absWorktree} is not a standard (non-bare) git working copy — no directory .git found. ` +
        "Already a linked worktree? Use `prx repo adopt --from-worktree` instead.",
      "not_a_standard_repo",
    );
  }

  const inferred = inferRepoFromWorktree(absWorktree, runner);
  const targetBarePath = canonicalBarePathFromParsed(bareRoot, inferred.parsed);
  if (existsSync(targetBarePath)) {
    throw new RepoConvertError(
      `A bare already exists at ${targetBarePath} for ${inferred.repo_id}. ` +
        "Attaching this worktree to a different, already-registered bare is not supported by " +
        "`repo convert-to-bare` — reconcile the two histories manually, then `prx repo adopt`.",
      "bare_path_exists",
    );
  }

  const entries = listWorktrees(absWorktree, runner);
  const self = entries.find((e) => resolve(e.path) === absWorktree);
  const siblingWorktrees = entries
    .filter((e) => resolve(e.path) !== absWorktree)
    .map((e) => resolve(e.path));

  const headResult = runner(["git", "rev-parse", "HEAD"], { cwd: absWorktree, check: false });
  if (headResult.status !== 0) {
    throw new RepoConvertError(
      `git rev-parse HEAD failed in ${absWorktree}: ${(headResult.stderr || headResult.stdout).trim()}`,
      "head_unresolvable",
    );
  }
  const headSha = headResult.stdout.trim();

  const branchResult = runner(["git", "symbolic-ref", "--short", "HEAD"], {
    cwd: absWorktree,
    check: false,
  });
  const branch = branchResult.status === 0 ? branchResult.stdout.trim() : null;

  const statusResult = runner(["git", "status", "--porcelain"], { cwd: absWorktree, check: false });
  if (statusResult.status !== 0) {
    throw new RepoConvertError(
      `git status failed in ${absWorktree}: ${(statusResult.stderr || statusResult.stdout).trim()}`,
      "status_failed",
    );
  }
  const willStash = statusResult.stdout.trim().length > 0;

  const lockedEntries = [self, ...entries.filter((e) => e !== self)].filter(
    (e): e is WorktreeEntry => !!e && e.locked !== null,
  );

  const plan: RepoConvertPlan = {
    repoId: inferred.repo_id,
    sourceGitDir: gitPath,
    targetBarePath,
    worktreePath: absWorktree,
    branch,
    headSha,
    willStash,
    siblingWorktrees,
  };

  if (lockedEntries.length > 0) {
    for (const entry of lockedEntries) {
      const unlock = runner(["git", "worktree", "unlock", entry.path], {
        cwd: absWorktree,
        check: false,
      });
      if (unlock.status !== 0) {
        throw new RepoConvertError(
          `${entry.path} is locked (${entry.locked}) and could not be unlocked: ` +
            `${(unlock.stderr || unlock.stdout).trim()}. Resolve the lock before converting.`,
          "worktree_locked",
        );
      }
    }
  }

  return { plan, entries };
}

export function convertWorktreeToBare({
  worktreePath,
  bareRoot,
  store,
  runner = defaultRepoRunner,
  dryRun = false,
  now = () => new Date(),
}: RepoConvertOptions): RepoConvertResult {
  const absWorktree = resolve(worktreePath);
  const { plan } = buildPlan(absWorktree, bareRoot, runner);

  if (dryRun) {
    return { kind: "planned", plan };
  }

  let stashed = false;
  if (plan.willStash) {
    const stashMessage = `prx repo convert-to-bare: ${now().toISOString()}`;
    const stashPush = runner(["git", "stash", "push", "-u", "-m", stashMessage], {
      cwd: absWorktree,
      check: false,
    });
    if (stashPush.status !== 0) {
      throw new RepoConvertError(
        `git stash push failed in ${absWorktree}: ${(stashPush.stderr || stashPush.stdout).trim()}`,
        "stash_push_failed",
      );
    }
    // `git stash push` can exit 0 while creating no new entry at all — e.g.
    // a bare submodule-pointer bump with no other diff can leave nothing it
    // considers stash-worthy ("No local changes to save"), even though
    // `git status --porcelain` (which `plan.willStash` is based on) showed
    // something. Blindly trusting exit-status-0 here is dangerous: a later
    // unconditional `git stash pop` would then grab whatever PRE-EXISTING,
    // totally unrelated stash happens to already sit at stash@{0} — a real
    // incident hit converting bounded-systems/site, which popped a months-old
    // "WIP on feat/sri-csp" stash and produced a genuine merge conflict
    // against work that had nothing to do with this conversion. Confirm our
    // own entry actually landed at stash@{0} by message before trusting it.
    const stashList = runner(["git", "stash", "list"], { cwd: absWorktree, check: false });
    stashed = stashList.status === 0 && (stashList.stdout.split("\n")[0] ?? "").includes(stashMessage);
  }

  mkdirSync(dirname(plan.targetBarePath), { recursive: true });
  try {
    renameSync(plan.sourceGitDir, plan.targetBarePath);
  } catch (err) {
    throw new RepoConvertError(
      `Failed to move ${plan.sourceGitDir} -> ${plan.targetBarePath}: ${(err as Error).message}`,
      "git_dir_move_failed",
    );
  }
  const bareConfig = runner(["git", "config", "core.bare", "true"], {
    cwd: plan.targetBarePath,
    check: false,
  });
  if (bareConfig.status !== 0) {
    throw new RepoConvertError(
      `git config core.bare true failed on ${plan.targetBarePath}: ` +
        `${(bareConfig.stderr || bareConfig.stdout).trim()}. The moved .git is at ${plan.targetBarePath}; ` +
        `the workdir at ${absWorktree} still has its files but no .git — recover manually.`,
      "bare_config_failed",
    );
  }
  // Always enable worktreeConfig, unconditionally. If the source repo had
  // already enabled it before conversion (e.g. from prior `git worktree`
  // use), `git worktree add` below does *not* reliably add the per-worktree
  // `core.bare=false` override that a from-scratch enable gets — leaving
  // every worktree it creates permanently confused about being "inside a
  // bare repo" (`git status` fails with "must be run in a work tree", even
  // though `git worktree list` shows it correctly). Enabling it here and
  // setting the override explicitly below sidesteps that regardless of
  // whether it was already on.
  const worktreeConfigExt = runner(["git", "config", "extensions.worktreeConfig", "true"], {
    cwd: plan.targetBarePath,
    check: false,
  });
  if (worktreeConfigExt.status !== 0) {
    throw new RepoConvertError(
      `git config extensions.worktreeConfig true failed on ${plan.targetBarePath}: ` +
        `${(worktreeConfigExt.stderr || worktreeConfigExt.stdout).trim()}`,
      "bare_config_failed",
    );
  }

  const backupPath = uniqueBackupPath(absWorktree);
  renameSync(absWorktree, backupPath);
  mkdirSync(absWorktree, { recursive: true });

  const worktreeAddCmd =
    plan.branch !== null
      ? ["git", "-C", plan.targetBarePath, "worktree", "add", absWorktree, plan.branch]
      : ["git", "-C", plan.targetBarePath, "worktree", "add", "--detach", absWorktree, plan.headSha];
  const worktreeAdd = runner(worktreeAddCmd, { check: false });
  if (worktreeAdd.status !== 0) {
    throw new RepoConvertError(
      `git worktree add failed for ${absWorktree}: ${(worktreeAdd.stderr || worktreeAdd.stdout).trim()}. ` +
        `Original content preserved at ${backupPath}; the bare now lives at ${plan.targetBarePath}.`,
      "worktree_add_failed",
    );
  }
  markWorktreeNotBare(absWorktree, runner);

  if (stashed) {
    const stashPop = runner(["git", "stash", "pop"], { cwd: absWorktree, check: false });
    if (stashPop.status !== 0) {
      throw new RepoConvertError(
        `git stash pop failed in ${absWorktree} (likely a conflict): ` +
          `${(stashPop.stderr || stashPop.stdout).trim()}. The stash is preserved (not dropped); ` +
          `original content is also preserved at ${backupPath}. Resolve manually, then re-run ` +
          "`prx repo adopt --from-worktree` to register.",
        "stash_pop_conflict",
      );
    }
  }

  // `git worktree add` checks out tracked files but never initializes
  // submodules — a repo with a .gitmodules ends up with empty placeholder
  // directories at every submodule path until this runs. Run after the
  // stash pop so the submodule pointer is whatever the final, fully-resolved
  // tree pins it to (stash pop can itself update the pinned commit, if a
  // submodule bump was part of what got stashed).
  if (existsSync(join(absWorktree, ".gitmodules"))) {
    const submoduleInit = runner(["git", "submodule", "update", "--init", "--recursive"], {
      cwd: absWorktree,
      check: false,
    });
    if (submoduleInit.status !== 0) {
      throw new RepoConvertError(
        `git submodule update --init failed in ${absWorktree}: ` +
          `${(submoduleInit.stderr || submoduleInit.stdout).trim()}. ` +
          `Original content preserved at ${backupPath}.`,
        "submodule_init_failed",
      );
    }
  }

  // `mv`s every backup file that isn't already present at the same path in
  // the fresh worktree. Tracked-file content at a shared path is git's own
  // responsibility, established either by the fresh checkout directly or by
  // `stash pop` reapplying the pre-conversion diff on top of it (note: for a
  // stashed file, backup's copy is the *clean* pre-push snapshot — `stash
  // push` reverts the working tree before we rename it away — so it will
  // legitimately differ from the popped copy; that's expected, not a bug).
  // Only content git's checkout/stash machinery never touches at all —
  // untracked-and-gitignored files — is genuinely at risk of being stranded,
  // and that only happens when it's missing from the fresh worktree, which
  // is exactly what this loop moves over.
  reconcileBackupFiles(backupPath, absWorktree);

  let repairedSiblings: string[] = [];
  if (plan.siblingWorktrees.length > 0) {
    repairedSiblings = repairSiblingWorktrees(plan.targetBarePath, plan.siblingWorktrees, runner);
  }

  rmSync(backupPath, { recursive: true, force: true });

  const adopt = adoptRepo({ worktreePath: absWorktree, store, runner, force: true, now });

  return { kind: "converted", plan, stashed, repairedSiblings, adopt };
}

function reconcileBackupFiles(backupPath: string, worktreePath: string): void {
  function walk(rel: string): void {
    const srcDir = join(backupPath, rel);
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      // .git is git's own domain — in the fresh worktree the top-level .git is
      // a linked-worktree gitdir *file*, not a directory; nested .git entries
      // (submodules) are git's to manage too. Anything named .git left behind
      // in the backup (a stray side-directory from an unrelated tool watching
      // the repo, a leftover from a prior partial run) must never be walked
      // into or merged.
      if (entry.name === ".git") continue;
      const relPath = join(rel, entry.name);
      const src = join(backupPath, relPath);
      const dest = join(worktreePath, relPath);
      if (existsSync(dest)) {
        // Already present at this path — git's own checkout (or stash pop
        // on top of it) is authoritative for tracked content; leave it.
        if (entry.isDirectory()) walk(relPath);
        continue;
      }
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(src, dest);
    }
  }
  walk("");
}

function repairSiblingWorktrees(
  barePath: string,
  siblingPaths: string[],
  runner: RepoRunner,
): string[] {
  const stillBroken = (): string[] =>
    siblingPaths.filter((p) => resolveGitCommonDir(p, runner) !== resolve(barePath));

  runner(["git", "worktree", "repair", ...siblingPaths], { cwd: barePath, check: false });
  let broken = stillBroken();
  if (broken.length > 0) {
    runner(["git", "worktree", "repair", ...siblingPaths], { cwd: barePath, check: false });
    broken = stillBroken();
  }
  if (broken.length > 0) {
    throw new RepoConvertError(
      `git worktree repair left ${broken.length} sibling worktree(s) with a stale .git pointer ` +
        `after two passes: ${broken.join(", ")}`,
      "sibling_repair_incomplete",
    );
  }
  // Siblings pre-date this conversion, so unlike the freshly-created main
  // worktree they may already carry a correct per-worktree override — but
  // if they don't (the pre-conversion repo's shared config never needed
  // one, since core.bare was false then), they now inherit the same
  // now-true core.bare as the main worktree. Cheap and idempotent either way.
  for (const sibling of siblingPaths) {
    markWorktreeNotBare(sibling, runner);
    repairSiblingSubmodules(sibling, runner);
  }
  return siblingPaths;
}

// `git worktree repair` fixes a sibling's own top-level .git pointer file,
// but a submodule checked out *inside* that sibling has two of its own,
// separate references that repair never touches, both baked in at whatever
// point `git submodule update --init` originally ran (long before this
// conversion) and both now stale:
//   1. The submodule's own `.git` gitfile — an absolute-path `gitdir:`
//      pointer into the (now-moved) bare's `worktrees/<name>/modules/<sub>`
//      admin directory. Broken pointer surfaces as `fatal: not a git
//      repository: <mangled path>` on any git command run inside the
//      submodule dir.
//   2. That admin directory's own `config` — a `core.worktree` entry
//      recorded as a *relative* path from the admin dir back to the
//      submodule's checkout, computed once at init time. Once the bare (and
//      so the admin dir) moves, that relative path no longer resolves to
//      the right place even after fixing (1) — surfaces the same
//      `fatal: not a git repository` error one level down, from inside the
//      submodule's *own* commands (status, diff, etc.), even though `-C
//      <submodule> rev-parse --is-inside-work-tree` reports true.
// Fix both directly: re-derive the sibling's own (already-repaired)
// admin-dir name from its outer .git pointer — never assume it equals
// basename(siblingPath), since git can suffix it on a name collision at
// `worktree add` time — then point the submodule's gitdir at
// `<that-admin-dir>/modules/<name>` (already exists; moved wholesale with
// the rest of .git) and set `core.worktree` there to an *absolute* path.
// Absolute avoids re-deriving the relative depth by hand — a computation
// this function has no reason to get exactly right when git will happily
// accept the unambiguous form instead.
function repairSiblingSubmodules(siblingPath: string, runner: RepoRunner): void {
  const gitmodulesPath = join(siblingPath, ".gitmodules");
  if (!existsSync(gitmodulesPath)) {
    return;
  }

  let outerGitdir: string;
  try {
    const outerGitFile = readFileSync(join(siblingPath, ".git"), "utf8").trim();
    const outerMatch = outerGitFile.match(/^gitdir:\s*(.+)$/);
    if (!outerMatch) return;
    outerGitdir = outerMatch[1]!;
  } catch {
    return;
  }

  const listResult = runner(
    ["git", "config", "--file", gitmodulesPath, "--get-regexp", "submodule\\..*\\.path"],
    { cwd: siblingPath, check: false },
  );
  if (listResult.status !== 0) {
    return;
  }
  for (const line of listResult.stdout.split("\n")) {
    const entryMatch = line.match(/^submodule\.(.+)\.path (.+)$/);
    if (!entryMatch) continue;
    const [, submoduleName, submodulePath] = entryMatch as [string, string, string];
    const submoduleGitFile = join(siblingPath, submodulePath, ".git");
    let submoduleGitStat;
    try {
      submoduleGitStat = statSync(submoduleGitFile);
    } catch {
      // Not initialized in this sibling — nothing to repair.
      continue;
    }
    if (submoduleGitStat.isDirectory()) {
      // Already a real directory (an unlikely but harmless shape this
      // function has nothing to fix) — nothing to repair.
      continue;
    }
    const newGitdir = join(outerGitdir, "modules", submoduleName);
    if (!existsSync(newGitdir)) {
      // No corresponding modules/ entry moved over; leave the stale pointer
      // in place rather than point it somewhere that doesn't exist.
      continue;
    }
    // The stat above is a "should I even attempt this" decision, not a
    // guarantee the write will succeed — this repo's own submodule dir is
    // local, single-process, fully-owned state for the duration of this
    // operation, but there's no reason to leave a check-then-use gap when a
    // try/catch on the write itself is just as simple and closes it.
    try {
      writeFileSync(submoduleGitFile, `gitdir: ${newGitdir}\n`);
    } catch (err) {
      throw new RepoConvertError(
        `Failed to rewrite submodule gitdir pointer for ${submoduleName} in ${siblingPath}: ` +
          `${(err as Error).message}`,
        "sibling_submodule_repair_failed",
      );
    }
    const submoduleWorktreePath = join(siblingPath, submodulePath);
    const coreWorktree = runner(
      ["git", "config", "--file", join(newGitdir, "config"), "core.worktree", submoduleWorktreePath],
      { cwd: siblingPath, check: false },
    );
    if (coreWorktree.status !== 0) {
      throw new RepoConvertError(
        `git config core.worktree failed for submodule ${submoduleName} in ${siblingPath}: ` +
          `${(coreWorktree.stderr || coreWorktree.stdout).trim()}`,
        "sibling_submodule_repair_failed",
      );
    }
  }
}

// A linked worktree must never appear "bare" to git — but when the bare's
// shared config has `core.bare=true` (always true right after this module
// moves .git there) *and* `extensions.worktreeConfig` was already enabled
// on the source repo before conversion (e.g. from prior `git worktree`
// use), `git worktree add` does not reliably add the per-worktree override
// that undoes it. The result: `git status`/`rev-parse --is-inside-work-tree`
// fail with "must be run in a work tree" even though `git worktree list`
// shows the worktree correctly. Setting the override explicitly, every
// time, sidesteps relying on `worktree add`'s automatic behavior.
function markWorktreeNotBare(worktreePath: string, runner: RepoRunner): void {
  const result = runner(["git", "config", "--worktree", "core.bare", "false"], {
    cwd: worktreePath,
    check: false,
  });
  if (result.status !== 0) {
    throw new RepoConvertError(
      `git config --worktree core.bare false failed in ${worktreePath}: ` +
        `${(result.stderr || result.stdout).trim()}`,
      "worktree_bare_flag_failed",
    );
  }
}
