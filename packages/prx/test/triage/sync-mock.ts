// Shared test seam for the canonical reconcile `runBeadsSync` (src/sync/run.ts).
//
// GH-2316 migrated the triage write verbs (apply, prioritize, prioritize-bulk,
// drift-fix, migrate-axis-value, prune-merged) off the retired destructive
// `bd github sync --pull-only --prefer-github` shell-out onto the status-only
// `runBeadsSync`. The verbs no longer take a synchronous `runBdGithubSync`
// returning `{ exitCode, stdout, stderr }`; they take an async `runBeadsSync`
// returning a `Promise<BeadsSyncResult>` and stream stdout/stderr to an output
// sink. This helper adapts the old `{ exitCode, stdout, stderr }` fixture shape
// onto the new seam so the verb tests assert the reconcile chain without
// spawning real `gh`/`bd` traffic. Mirrors the inline seam in apply.test.ts.

import type { runBeadsSync as defaultRunBeadsSync, BeadsSyncResult } from "../../src/sync/run.ts";

export type SyncFixture = { exitCode: number; stdout?: string; stderr?: string };

/**
 * Build a `runBeadsSync` mock from the legacy `{ exitCode, stdout, stderr }`
 * fixture shape. The returned function streams any stdout/stderr to the verb's
 * capture sink (so the audit `bdStdout`/`bdStderr` and `OK/FAIL bd github sync`
 * log lines populate exactly as production does) and resolves a synthetic
 * `BeadsSyncResult`. `onCall` fires once per invocation for call-count asserts.
 */
export function makeRunBeadsSyncMock(
  fixture: SyncFixture,
  onCall?: (opts: unknown) => void,
): typeof defaultRunBeadsSync {
  return (async (
    opts: unknown,
    output: { log: (l: string) => void; error: (l: string) => void },
  ): Promise<BeadsSyncResult> => {
    onCall?.(opts);
    if (fixture.stdout?.trim()) output.log(fixture.stdout.trim());
    if (fixture.stderr?.trim()) output.error(fixture.stderr.trim());
    return {
      exitCode: fixture.exitCode,
      summary: {
        repo: "bdelanghe/ai-home",
        domain: "gh",
        scanned: 0,
        pinned: 0,
        skipped: 0,
        pulled: 0,
        pushed: 0,
        closedByPull: 0,
        failed: 0,
        pullFailed: 0,
        pullDeferred: 0,
        pushDeferred: 0,
        deferred: 0,
        budgetPaused: false,
        dryRun: false,
        durationMs: 0,
      },
      pairs: [],
    };
    // The verbs accept `runBeadsSync?: typeof defaultRunBeadsSync`; the cast
    // bridges the structural arg-type gap (RunBeadsSyncOptions vs unknown).
  }) as unknown as typeof defaultRunBeadsSync;
}
