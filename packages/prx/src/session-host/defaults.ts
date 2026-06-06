/**
 * Real session-host seams (session-substrate slice 5) — what the in-VM daemon
 * runs on, vs. the slice-1 in-memory/fake seams used in tests.
 *
 * - `procStartProcess` holds a process via {@link @bounded-systems/proc.spawnDetached}
 *   — **array args, no shell**, so a user-supplied command can't inject a shell
 *   metacharacter. Output is appended to the session's log (the tailable stream).
 * - `isAliveProcess` / `signalProcess` are `process.kill` (signal 0 to probe).
 * - `defaultSessionHostDeps` assembles them over the durable file store.
 *
 * These compose with {@link ./daemon.runSessionHostServe} to make a real daemon.
 * The Lima deploy (mirroring `lima-keeperd.ts`) + the `prx session-host serve`
 * CLI verb are the remaining slice; this is the local-real piece.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { processEnv } from "@bounded-systems/env";
import { spawnDetached } from "@bounded-systems/proc";

import { type SessionHostDeps, type StartSpec } from "./handler.ts";
import { createFileSessionStore } from "./store-file.ts";

/** Hold a process detached, no shell, output → the session log. */
export function procStartProcess(spec: StartSpec): { pid: number } {
  return spawnDetached([spec.command, ...spec.args], {
    logPath: spec.logPath,
    // Held process env = the daemon's env with the request's overrides on top.
    env: { ...processEnv(), ...(spec.env ?? {}) },
    ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
  });
}

/** True iff `pid` is a live process. `kill(pid, 0)` probes without signalling. */
export function isAliveProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH ⇒ gone; EPERM ⇒ alive but not ours to signal (still "running").
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Deliver `signal` to `pid` (no-op if it's already gone). */
export function signalProcess(pid: number, signal: string): void {
  try {
    process.kill(pid, signal as NodeJS.Signals);
  } catch {
    // already exited — nothing to signal.
  }
}

/**
 * The real deps the in-VM daemon runs on: durable file store under
 * `<stateDir>/sessions`, logs under `<stateDir>/logs`, proc-backed spawn +
 * `process.kill` liveness.
 */
export function defaultSessionHostDeps(opts: { stateDir: string }): SessionHostDeps {
  const logDir = join(opts.stateDir, "logs");
  mkdirSync(logDir, { recursive: true });
  return {
    store: createFileSessionStore(join(opts.stateDir, "sessions")),
    logDir,
    startProcess: procStartProcess,
    isAlive: isAliveProcess,
    signal: signalProcess,
    now: () => new Date().toISOString(),
  };
}
