/**
 * Narrow wrapper for `bd close` (post-merge handoff only).
 *
 * Mirrors `src/tools/gh_issue_close.ts`. Intentionally separate from
 * `src/tools/bd.ts` because:
 *   - `policy.ts` hard-blocks `bd:close` for every state×role combination
 *     (see `BLOCKED.bd`). The execBd gate cannot route close.
 *   - Closing a bd record post-merge is the **pin-zero handoff** described in
 *     `docs/architecture/bd-canonical-pr-linkage.md`: when the merged PR
 *     references `Refs <bd-id>` (no GH pin → no auto-close projection), the
 *     bd record must be closed explicitly. This sits inside the lifecycle
 *     chain — same slot as `gh issue close` for the cross-canonical arm.
 *
 * This wrapper is the single allowed surface for `bd close` from prx. It is
 * invoked by `prx submit postmerge` (GH-1773). Do not generalize this to a
 * full `bd close` group wrapper — keep the surface narrow.
 */

import { processEnv } from "@bounded-systems/env";
import { spawnCapture } from "@bounded-systems/proc";

export type BdIssueCloseResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type BdIssueCloseOptions = {
  /** Bd surface id to close (e.g. `BD-deadbeef` or a long bd id). */
  id: string;
  /** Optional close reason — forwarded to bd as `--reason <value>`. */
  reason?: string;
  /** Working directory for the spawn — determines the bd workspace. */
  cwd?: string;
};

export type BdIssueCloseEnv = Record<string, string | undefined>;

export type BdIssueCloseSpawnResult = {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: Error | undefined;
};

export type BdIssueCloseSpawn = (
  file: string,
  args: string[],
  options: { cwd?: string | undefined; env: NodeJS.ProcessEnv; encoding: "utf8" },
) => BdIssueCloseSpawnResult;

const defaultBdIssueCloseSpawn: BdIssueCloseSpawn = (file, args, options) => {
  const r = spawnCapture([file, ...args], {
    cwd: options.cwd,
    env: options.env,
  });
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    error: r.error,
  };
};

/**
 * Build the `bd close` argv (without the leading `bd` binary).
 * Exposed for dry-run rendering and tests.
 */
export function buildBdIssueCloseArgs(opts: BdIssueCloseOptions): string[] {
  const args: string[] = ["close", opts.id];
  if (opts.reason) {
    args.push("--reason", opts.reason);
  }
  return args;
}

/**
 * Execute `bd close` with the given options. Returns the captured
 * stdout/stderr and exit code.
 *
 * Mirrors the env-isolation behavior of `execBd`: clears any inherited
 * `BEADS_DIR` so the bd binary resolves the workspace from `cwd` rather
 * than a parent override.
 */
export function execBdIssueClose(
  opts: BdIssueCloseOptions,
  env: BdIssueCloseEnv = processEnv(),
  spawn: BdIssueCloseSpawn = defaultBdIssueCloseSpawn,
): BdIssueCloseResult {
  const args = buildBdIssueCloseArgs(opts);

  const childEnv = { ...env } as Record<string, string | undefined>;
  delete childEnv.BEADS_DIR;

  const result = spawn("bd", args, {
    cwd: opts.cwd,
    env: childEnv as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
  const stdout =
    typeof result.stdout === "string"
      ? result.stdout
      : (result.stdout?.toString() ?? "");
  const stderr =
    typeof result.stderr === "string"
      ? result.stderr
      : (result.stderr?.toString() ?? "");
  const exitCode = result.status ?? 1;

  return { exitCode, stdout, stderr };
}

export function formatBdIssueCloseResult(
  result: BdIssueCloseResult,
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  if (result.exitCode === 0) {
    return result.stdout.trimEnd();
  }
  const fallback = result.stderr || result.stdout;
  return fallback.trimEnd();
}
