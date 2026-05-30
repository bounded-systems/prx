/**
 * Stale git lock recovery (ai-home-bbdm1 / GH home-sync foot-gun).
 *
 * When two git invocations race — or one crashes mid-operation — git leaves an
 * `index.lock` (or `*.lock`) behind and every later invocation aborts with:
 *
 *   fatal: Unable to create '<path>/index.lock': File exists.
 *   Another git process seems to be running in this repository ...
 *
 * git itself can never remove the lock automatically: from its vantage point it
 * cannot tell a crashed predecessor from a live sibling. prx has more context —
 * it can ask the OS whether any process still holds the file open (lsof) and how
 * old / how large the lock is — so it CAN make the call safely.
 *
 * Policy (operator-chosen, ai-home-bbdm1): auto-remove + retry, safe-guarded.
 *   - A process still holds the lock (lsof)            -> never remove; report.
 *   - Holder cannot be determined (lsof unavailable)   -> conservative: report.
 *   - No holder AND (0-byte OR older than threshold)   -> remove, signal retry.
 *   - No holder but fresh & non-empty                  -> looks live; report.
 *
 * The 0-byte rule is safe specifically *because* it is gated on "no holder":
 * a live git op that just opened (but has not yet written) its 0-byte lock still
 * holds the fd, so lsof catches it. An unheld 0-byte lock means the writer is
 * already gone.
 *
 * All filesystem / process probes are injectable so the decision logic is unit
 * testable without touching the real FS or spawning lsof. The real FS probes go
 * through the @bounded-systems/fs capability (not raw node:fs) and the holder
 * probe through @bounded-systems/proc, so this stays within the git package's
 * proc/policy/env/fs boundary.
 */
import { statPath, removeFile } from "@bounded-systems/fs";
import { spawnCapture } from "@bounded-systems/proc";

/**
 * Matches git's lock-contention message and extracts the lock path. Covers
 * `index.lock` and any sibling (`shallow.lock`, `config.lock`, `HEAD.lock`, …)
 * since git uses the same "Unable to create '<path>': File exists" phrasing for
 * every `.lock` file.
 */
const LOCK_ERROR_RE = /Unable to create '([^']+\.lock)': File exists/;

/** Default age past which an *unheld* lock is treated as abandoned. */
export const DEFAULT_STALE_AGE_MS = 30_000;

export type LockStat = {
  /** Size in bytes; 0 for a lock git opened but never wrote to. */
  sizeBytes: number;
  /** Last-modification time, epoch ms. */
  mtimeMs: number;
};

export type LockRecoveryDeps = {
  /** Stat the lock file; `null` when it no longer exists. */
  statLock?: (path: string) => LockStat | null;
  /**
   * PIDs currently holding the lock file open, `[]` when none, or `null` when
   * the holder set could not be determined (e.g. lsof is not installed). `null`
   * is treated as "unsafe to remove".
   */
  lockHolders?: (path: string) => number[] | null;
  /** Remove the lock file. Best-effort; `force` semantics. */
  removeLock?: (path: string) => void;
  /** Clock seam for age comparisons. */
  now?: () => number;
  /** Override the staleness threshold (ms). */
  staleAgeMs?: number;
};

export type LockRecovery =
  | { recovered: true; path: string; removed: boolean }
  | { recovered: false; path: string | null; reason: string };

/** Extract the lock path from a git stderr blob, or `null` if absent. */
export function parseLockPath(stderr: string): string | null {
  const m = LOCK_ERROR_RE.exec(stderr);
  return m ? m[1]! : null;
}

function defaultStatLock(path: string): LockStat | null {
  const st = statPath(path);
  return st === null ? null : { sizeBytes: st.sizeBytes, mtimeMs: st.mtimeMs };
}

function defaultLockHolders(path: string): number[] | null {
  // `lsof -t -- <path>` prints one PID per line for every process holding the
  // file open. Exit 1 with empty stdout is lsof's normal "no matches" — i.e. no
  // holder. A spawn error (lsof missing) leaves us unable to verify -> null.
  const r = spawnCapture(["lsof", "-t", "--", path]);
  if (r.error) return null;
  const pids = r.stdout
    .split("\n")
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  // status 0 -> matches found; non-zero with no pids -> no holder.
  return pids;
}

function defaultRemoveLock(path: string): void {
  removeFile(path);
}

/**
 * Decide whether the lock named in `stderr` is a safe-to-clear stale lock and,
 * if so, remove it. Returns whether the caller may now retry the git op.
 */
export function recoverStaleLock(
  stderr: string,
  deps: LockRecoveryDeps = {},
): LockRecovery {
  const path = parseLockPath(stderr);
  if (!path) {
    return { recovered: false, path: null, reason: "no lock path in git error" };
  }

  const statLock = deps.statLock ?? defaultStatLock;
  const lockHolders = deps.lockHolders ?? defaultLockHolders;
  const removeLock = deps.removeLock ?? defaultRemoveLock;
  const now = deps.now ?? Date.now;
  const staleAgeMs = deps.staleAgeMs ?? DEFAULT_STALE_AGE_MS;

  const stat = statLock(path);
  if (stat === null) {
    // The lock vanished between git's failure and our check — nothing to
    // remove, and a retry should now succeed.
    return { recovered: true, path, removed: false };
  }

  const holders = lockHolders(path);
  if (holders === null) {
    return {
      recovered: false,
      path,
      reason: "cannot verify lock holder (lsof unavailable) — not removing",
    };
  }
  if (holders.length > 0) {
    return {
      recovered: false,
      path,
      reason: `lock is held by pid ${holders.join(", ")} — not removing`,
    };
  }

  const ageMs = now() - stat.mtimeMs;
  const stale = stat.sizeBytes === 0 || ageMs > staleAgeMs;
  if (!stale) {
    return {
      recovered: false,
      path,
      reason: `lock looks active (${Math.round(ageMs)}ms old, ${stat.sizeBytes}b) — not removing`,
    };
  }

  removeLock(path);
  return { recovered: true, path, removed: true };
}

type MinimalSpawnResult = {
  status: number | null;
  stdout?: unknown;
  stderr?: unknown;
  error?: Error | undefined;
};

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}

/** True when a spawn result is a git invocation that failed on lock contention. */
export function isRetryableGitLock(file: string, result: MinimalSpawnResult): boolean {
  if (file !== "git") return false;
  if ((result.status ?? 1) === 0 && !result.error) return false;
  return parseLockPath(asText(result.stderr)) !== null;
}

export type LockRecoveryHooks = LockRecoveryDeps & {
  /** Notified after each recovery attempt (recovered or not) for logging. */
  onRecover?: (recovery: LockRecovery) => void;
};

/**
 * Run a git invocation thunk, and on a lock-contention failure attempt a
 * single stale-lock recovery + retry. Generic over the thunk's exact result
 * type so callers keep their own result shape.
 */
export function runWithGitLockRecovery<R extends MinimalSpawnResult>(
  run: () => R,
  deps: LockRecoveryHooks = {},
): R {
  const first = run();
  if (!isRetryableGitLock("git", first)) return first;
  const recovery = recoverStaleLock(asText(first.stderr), deps);
  deps.onRecover?.(recovery);
  return recovery.recovered ? run() : first;
}

type SpawnSeam<O, R extends MinimalSpawnResult> = (
  file: string,
  args: string[],
  options: O,
) => R;

/**
 * Decorate a `(file, args, opts)` spawn seam so any **git** call that fails on
 * lock contention triggers a stale-lock recovery + single retry. Non-git calls
 * and non-lock failures pass straight through. Preserves the seam's exact
 * signature so it can wrap `SpawnLike`, `HomeSyncSpawn`, etc. unchanged.
 */
export function withGitLockRecovery<O, R extends MinimalSpawnResult>(
  inner: SpawnSeam<O, R>,
  deps: LockRecoveryHooks = {},
): SpawnSeam<O, R> {
  return (file, args, options) => {
    const first = inner(file, args, options);
    if (!isRetryableGitLock(file, first)) return first;
    const recovery = recoverStaleLock(asText(first.stderr), deps);
    deps.onRecover?.(recovery);
    return recovery.recovered ? inner(file, args, options) : first;
  };
}
