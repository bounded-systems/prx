/**
 * Shared command-runner seam for the keeperd Lima drivers (GH-201).
 *
 * Both the transport forward ({@link ./lima-transport}) and the daemon lifecycle
 * ({@link ./lima-keeperd}) shell out to `limactl`/`ssh`. They run commands
 * through this one seam — {@link spawnRun} by default (routed through
 * `@bounded-systems/proc` per the ambient-authority guard), a fake in tests — so
 * the orchestration stays fully offline-testable.
 */

import { spawnCapture } from "@bounded-systems/proc";

/** Result of running a command to completion. */
export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run a command (`cmd` + `args`) to completion. */
export type Run = (cmd: string, args: string[]) => RunResult;

/** Default {@link Run}: route through `@bounded-systems/proc` (no raw spawn). */
export const spawnRun: Run = (cmd, args) => {
  const res = spawnCapture([cmd, ...args]);
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
};
