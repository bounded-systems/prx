/**
 * @bounded-systems/proc — the subprocess capability.
 *
 * The ONE allowed spawn point. Shelling out to an external tool (git, gh, bd,
 * tmux, …) is a dependency on that tool existing in the environment; routing
 * every spawn through this capability turns those hidden runtime edges into a
 * visible @bounded-systems/proc import. The boundary tests forbid raw spawnSync / Bun.spawn
 * / child_process everywhere else, so the import graph stays the complete
 * dependency graph.
 *
 * Lifted from prx-mux's CommandRunner so the mux and every future tool wrapper
 * share one spawn implementation + the injectable runner seam. The streaming,
 * temp-file-backed capture primitives (for tool output that overflows
 * spawnSync's in-memory cap) live alongside it in ./capture.ts.
 */
import { spawnSync } from "node:child_process";
import { constants as osConstants } from "node:os";

import { processEnv } from "@bounded-systems/env";

import { spawnCapture } from "./capture.ts";

export type {
  SpawnCaptureResult,
  SpawnCaptureOptions,
  SpawnCaptureFn,
  StreamCaptureOptions,
} from "./capture.ts";
export {
  spawnCapture,
  streamCapture,
  isCaptureFailure,
  captureFailureDetail,
} from "./capture.ts";

export type CommandResult = {
  stdout: string;
  stderr: string;
  status: number;
};

export interface RunOptions {
  cwd?: string;
  /** When not false (default), a non-zero exit throws. */
  check?: boolean;
  env?: NodeJS.ProcessEnv;
  /**
   * "pipe" (default) captures stdout/stderr into the result; "inherit" wires
   * all three streams to this process's terminal. An explicit array is passed
   * straight to spawnSync for advanced wiring (e.g. ["inherit", 2, "inherit"]
   * to route the child's stdout to our stderr). With "inherit" or an array,
   * any stream not piped comes back empty in the result.
   */
  stdio?: "pipe" | "inherit" | Array<"inherit" | "pipe" | "ignore" | number>;
  /**
   * Wall-clock budget in ms. On expiry the child is killed and `spawnSync`
   * reports an `ETIMEDOUT` error, which (like any spawn error) is thrown
   * regardless of `check` — callers that need to recover catch it.
   */
  timeout?: number;
  /** Serializable stdin written to the child then closed. */
  input?: string;
}

/** Injectable spawn seam — tests and policy layers substitute their own. */
export type CommandRunner = (cmd: string[], options?: RunOptions) => CommandResult;

function signalExitStatus(signal: NodeJS.Signals | string | null): number {
  if (!signal) return 1;
  const signals = osConstants.signals as Record<string, number>;
  const num = signals[signal as string];
  return 128 + (typeof num === "number" ? num : 0);
}

export const defaultRunner: CommandRunner = (cmd, options = {}) => {
  const [file, ...args] = cmd;
  if (!file) {
    throw new Error("defaultRunner: empty command");
  }
  const customStdio =
    options.stdio && options.stdio !== "pipe" ? options.stdio : undefined;
  const result = spawnSync(file, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? processEnv(),
    ...(options.timeout ? { timeout: options.timeout } : {}),
    ...(options.input !== undefined ? { input: options.input } : {}),
    ...(customStdio ? { stdio: customStdio } : {}),
  });

  if (result.error) {
    throw result.error;
  }

  const status = result.status ?? signalExitStatus(result.signal);

  const commandResult: CommandResult = {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status,
  };

  if (options.check !== false && commandResult.status !== 0) {
    const error = new Error(
      commandResult.stderr.trim() || commandResult.stdout.trim(),
    );
    Object.assign(error, { result: commandResult });
    throw error;
  }

  return commandResult;
};

/**
 * Streaming sibling of {@link defaultRunner}: runs a command through
 * {@link spawnCapture} (temp-file-backed, no in-memory cap) and normalizes it to
 * a {@link CommandResult}, applying the same error/check semantics. Use this for
 * tools whose output can overflow spawnSync's buffer (`gh api`, `git log -p`).
 * Subprocess-env shaping is the caller's concern — pass it via `options.env`.
 */
export const runCaptured: CommandRunner = (cmd, options = {}) => {
  const result = spawnCapture(cmd, {
    cwd: options.cwd,
    env: options.env,
  });

  if (result.error) {
    throw result.error;
  }

  const commandResult: CommandResult = {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 0,
  };

  if (options.check !== false && commandResult.status !== 0) {
    const error = new Error(
      commandResult.stderr.trim() || commandResult.stdout.trim(),
    );
    Object.assign(error, { result: commandResult });
    throw error;
  }

  return commandResult;
};

export type { ProcRequest, ProcResult, ProcExecutor } from "./contract.ts";
export { procRequestSchema, localProcExecutor } from "./contract.ts";

export type { ProcCache, CachingProcExecutor, CachingProcOptions } from "./caching.ts";
export { cachingProcExecutor, inMemoryProcCache, policyCacheable } from "./caching.ts";

export type { SpawnDetachedOptions, SpawnDetachedResult } from "./spawn-detached.ts";
export { spawnDetached } from "./spawn-detached.ts";
