import { describe, expect, test } from "bun:test";

import {
  parseLockPath,
  recoverStaleLock,
  isRetryableGitLock,
  runWithGitLockRecovery,
  withGitLockRecovery,
  type LockRecovery,
  type LockStat,
} from "@bounded-systems/git";

const GIT_LOCK_STDERR = [
  "fatal: Unable to create '/repo/.git/worktrees/mainx1/index.lock': File exists.",
  "",
  "Another git process seems to be running in this repository ...",
].join("\n");

const LOCK_PATH = "/repo/.git/worktrees/mainx1/index.lock";

/** Build a deps bundle with sensible test defaults, overridable per case. */
function deps(overrides: {
  stat?: LockStat | null;
  holders?: number[] | null;
  now?: number;
} = {}) {
  const removed: string[] = [];
  return {
    removed,
    bundle: {
      statLock: () => (overrides.stat === undefined ? { sizeBytes: 0, mtimeMs: 0 } : overrides.stat),
      lockHolders: () => (overrides.holders === undefined ? [] : overrides.holders),
      removeLock: (p: string) => {
        removed.push(p);
      },
      now: () => overrides.now ?? 1_000_000,
      staleAgeMs: 30_000,
    },
  };
}

describe("parseLockPath", () => {
  test("extracts the lock path from git's contention message", () => {
    expect(parseLockPath(GIT_LOCK_STDERR)).toBe(LOCK_PATH);
  });

  test("matches non-index .lock siblings", () => {
    const stderr = "fatal: Unable to create '/r/.git/shallow.lock': File exists.";
    expect(parseLockPath(stderr)).toBe("/r/.git/shallow.lock");
  });

  test("returns null for unrelated errors", () => {
    expect(parseLockPath("fatal: not a git repository")).toBeNull();
    expect(parseLockPath("")).toBeNull();
  });
});

describe("recoverStaleLock", () => {
  test("removes + signals retry for an unheld 0-byte lock", () => {
    const d = deps({ stat: { sizeBytes: 0, mtimeMs: 999_999 }, holders: [] });
    const r = recoverStaleLock(GIT_LOCK_STDERR, d.bundle);
    expect(r.recovered).toBe(true);
    expect((r as Extract<LockRecovery, { recovered: true }>).removed).toBe(true);
    expect(d.removed).toEqual([LOCK_PATH]);
  });

  test("removes + signals retry for an unheld old non-empty lock", () => {
    // 60s old, past the 30s threshold.
    const d = deps({ stat: { sizeBytes: 42, mtimeMs: 940_000 }, holders: [], now: 1_000_000 });
    const r = recoverStaleLock(GIT_LOCK_STDERR, d.bundle);
    expect(r.recovered).toBe(true);
    expect(d.removed).toEqual([LOCK_PATH]);
  });

  test("never removes a held lock", () => {
    const d = deps({ stat: { sizeBytes: 0, mtimeMs: 0 }, holders: [4321] });
    const r = recoverStaleLock(GIT_LOCK_STDERR, d.bundle);
    expect(r.recovered).toBe(false);
    expect(d.removed).toEqual([]);
    expect((r as Extract<LockRecovery, { recovered: false }>).reason).toContain("4321");
  });

  test("conservative when holder cannot be verified (lsof unavailable)", () => {
    const d = deps({ stat: { sizeBytes: 0, mtimeMs: 0 }, holders: null });
    const r = recoverStaleLock(GIT_LOCK_STDERR, d.bundle);
    expect(r.recovered).toBe(false);
    expect(d.removed).toEqual([]);
    expect((r as Extract<LockRecovery, { recovered: false }>).reason).toContain("lsof");
  });

  test("does not remove a fresh unheld non-empty lock", () => {
    // 5s old, non-empty -> looks like a live op whose holder fd we just missed.
    const d = deps({ stat: { sizeBytes: 100, mtimeMs: 995_000 }, holders: [], now: 1_000_000 });
    const r = recoverStaleLock(GIT_LOCK_STDERR, d.bundle);
    expect(r.recovered).toBe(false);
    expect(d.removed).toEqual([]);
    expect((r as Extract<LockRecovery, { recovered: false }>).reason).toContain("active");
  });

  test("signals retry without removal when the lock already vanished", () => {
    const d = deps({ stat: null });
    const r = recoverStaleLock(GIT_LOCK_STDERR, d.bundle);
    expect(r.recovered).toBe(true);
    expect((r as Extract<LockRecovery, { recovered: true }>).removed).toBe(false);
    expect(d.removed).toEqual([]);
  });

  test("no-op for stderr without a lock path", () => {
    const r = recoverStaleLock("fatal: unrelated", {});
    expect(r.recovered).toBe(false);
    expect((r as Extract<LockRecovery, { recovered: false }>).path).toBeNull();
  });
});

describe("isRetryableGitLock", () => {
  test("true for a failed git call with a lock error", () => {
    expect(isRetryableGitLock("git", { status: 128, stderr: GIT_LOCK_STDERR })).toBe(true);
  });
  test("false for non-git callers", () => {
    expect(isRetryableGitLock("bd", { status: 128, stderr: GIT_LOCK_STDERR })).toBe(false);
  });
  test("false for a successful git call", () => {
    expect(isRetryableGitLock("git", { status: 0, stderr: GIT_LOCK_STDERR })).toBe(false);
  });
  test("false for a non-lock failure", () => {
    expect(isRetryableGitLock("git", { status: 1, stderr: "merge conflict" })).toBe(false);
  });
});

describe("runWithGitLockRecovery", () => {
  test("retries once after a successful recovery", () => {
    let calls = 0;
    const result = runWithGitLockRecovery(
      () => {
        calls += 1;
        return calls === 1
          ? { status: 128, stderr: GIT_LOCK_STDERR }
          : { status: 0, stderr: "" };
      },
      { statLock: () => null }, // lock vanished -> recovered, retry
    );
    expect(calls).toBe(2);
    expect(result.status).toBe(0);
  });

  test("does not retry when recovery is refused", () => {
    let calls = 0;
    const result = runWithGitLockRecovery(
      () => {
        calls += 1;
        return { status: 128, stderr: GIT_LOCK_STDERR };
      },
      { statLock: () => ({ sizeBytes: 0, mtimeMs: 0 }), lockHolders: () => [999] },
    );
    expect(calls).toBe(1);
    expect(result.status).toBe(128);
  });

  test("does not retry a non-lock failure", () => {
    let calls = 0;
    runWithGitLockRecovery(() => {
      calls += 1;
      return { status: 1, stderr: "boom" };
    });
    expect(calls).toBe(1);
  });
});

describe("withGitLockRecovery", () => {
  test("recovers + retries a git seam call, leaving non-git calls alone", () => {
    const recoveries: LockRecovery[] = [];
    let gitCalls = 0;
    const inner = (file: string, _args: string[], _opts: { cwd: string; encoding: "utf8" }) => {
      if (file !== "git") return { status: 0, stdout: "", stderr: "" };
      gitCalls += 1;
      return gitCalls === 1
        ? { status: 128, stdout: "", stderr: GIT_LOCK_STDERR }
        : { status: 0, stdout: "ok", stderr: "" };
    };
    const wrapped = withGitLockRecovery(inner, {
      statLock: () => null,
      onRecover: (r) => recoveries.push(r),
    });

    const git = wrapped("git", ["fetch"], { cwd: "/repo", encoding: "utf8" });
    expect(gitCalls).toBe(2);
    expect(git.status).toBe(0);
    expect(recoveries).toHaveLength(1);

    const bd = wrapped("bd", ["ready"], { cwd: "/repo", encoding: "utf8" });
    expect(bd.status).toBe(0);
    expect(recoveries).toHaveLength(1); // unchanged — non-git untouched
  });
});
