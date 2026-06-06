/**
 * Detached (daemon) spawn — the long-running counterpart to spawnCapture.
 *
 * spawnCapture runs a child to completion and returns its output; that is wrong
 * for a daemon (a dolt sql-server, a supervisor) that must OUTLIVE the parent.
 * `spawnDetached` starts the process detached + unref'd, ignores its stdio, and
 * returns the pid immediately without waiting. Like the rest of this package it
 * is the sanctioned spawn point — daemon launchers import it instead of reaching
 * for raw `child_process` (which the boundary tests forbid elsewhere).
 */

import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";

import { processEnv } from "@bounded-systems/env";

export type SpawnDetachedOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * When set, the child's stdout+stderr are appended to this file (created if
   * absent) — for a supervised daemon/session whose output must be tailable
   * after the parent exits. Omitted ⇒ stdio is ignored, as before.
   */
  logPath?: string;
};

export type SpawnDetachedResult = { pid: number };

/**
 * Start `cmd` ([bin, ...args]) as a detached background process. Returns its
 * pid; the child is unref'd so the parent may exit independently. With
 * `logPath`, the child's stdout+stderr are appended there (the parent's fd copy
 * is closed after spawn — the child keeps its own). Callers that need to *wait*
 * for output must use spawnCapture / streamCapture instead.
 */
export function spawnDetached(
  cmd: readonly string[],
  options: SpawnDetachedOptions = {},
): SpawnDetachedResult {
  const [bin, ...args] = cmd;
  if (!bin) throw new Error("spawnDetached: empty command");
  // O_APPEND|O_CREAT|O_WRONLY — append so a restart doesn't truncate the log.
  const fd = options.logPath !== undefined ? openSync(options.logPath, "a") : undefined;
  try {
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: options.env ?? processEnv(),
      detached: true,
      stdio: fd !== undefined ? ["ignore", fd, fd] : "ignore",
    });
    child.unref();
    if (typeof child.pid !== "number") {
      throw new Error(`spawnDetached: failed to start ${bin}`);
    }
    return { pid: child.pid };
  } finally {
    // The child inherited a dup of fd; the parent closes its own copy.
    if (fd !== undefined) closeSync(fd);
  }
}
