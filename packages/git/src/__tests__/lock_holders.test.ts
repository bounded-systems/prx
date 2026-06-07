// Exercises the default `lockHolders` probe (the real `lsof -t -- <path>` spawn
// through @bounded-systems/proc). lock.test.ts injects the holder seam to keep
// its decision logic hermetic; this covers the production probe itself. `lsof`
// on an unheld path reports no holders, so `statLock` is injected and no real
// file is needed (keeping the import surface within the package allowlist).

import { describe, expect, test } from "bun:test";

import { recoverStaleLock, isRetryableGitLock } from "@bounded-systems/git";

describe("recoverStaleLock with the default lsof holder probe", () => {
  test("an unheld stale lock resolves through the real lsof probe", () => {
    const lockPath = "/tmp/prx-lock-probe-unheld/index.lock";
    const stderr = `fatal: Unable to create '${lockPath}': File exists.`;

    // statLock injected (defaultStatLock is covered elsewhere); lockHolders and
    // removeLock left at their defaults so the real lsof spawn runs.
    const removed: string[] = [];
    const r = recoverStaleLock(stderr, {
      statLock: () => ({ sizeBytes: 0, mtimeMs: 0 }),
      removeLock: (p) => removed.push(p),
      now: () => 1_000_000,
    });

    // The lock path is echoed back regardless of the lsof outcome.
    expect(r.path).toBe(lockPath);
    if (r.recovered) {
      // lsof present + no holder → unheld 0-byte lock is treated as removable.
      expect(r.removed).toBe(true);
      expect(removed).toEqual([lockPath]);
    } else {
      // lsof unavailable in this environment → conservative refusal.
      expect(r.reason).toMatch(/lsof/);
    }
  });

  test("isRetryableGitLock tolerates a null/undefined stderr (asText guard)", () => {
    // No stderr field → asText(undefined) returns "" → no lock path → not
    // retryable. Covers the `value == null` arm of asText.
    expect(isRetryableGitLock("git", { status: 1 })).toBe(false);
  });
});
