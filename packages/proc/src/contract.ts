// The proc contract — a serializable, executor-agnostic description of a
// subprocess to run, plus the executor port that fulfills it.
//
// Designed "as if remote": a ProcRequest carries everything needed to run the
// process (command, args, cwd, explicit env, serializable stdin, timeout) with
// no local-only handles, and a ProcResult is a plain serializable value. So the
// same request can be fulfilled by the local executor today or a remote one
// later — the call site never assumes where the process runs. procRequestSchema
// is the validatable boundary (the "spec"); exec is async because crossing a
// machine boundary always is.
//
// `stdio: "inherit"` is the one non-remote-able mode (it wires the caller's
// terminal — tmux attach, an interactive shell). The local executor honors it;
// a remote executor would reject it or PTY-forward.
import { spawn } from "node:child_process";

import { z } from "zod";

import { processEnv } from "@bounded-systems/env";

import { streamCapture } from "./capture.ts";

export const procRequestSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  stdin: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  stdio: z.enum(["pipe", "inherit"]).default("pipe"),
});

export type ProcRequest = z.input<typeof procRequestSchema>;

export interface ProcResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly signal: string | null;
}

/**
 * The executor port. A local implementation spawns here; a remote one would
 * ship the request over a wire and run it elsewhere — the contract is identical.
 */
export interface ProcExecutor {
  exec(req: ProcRequest): Promise<ProcResult>;
}

function statusOf(status: number | null, signal: string | null): number {
  if (status !== null) return status;
  return signal ? 1 : 0;
}

/** The local executor: fulfills the contract by spawning on this machine. */
export function localProcExecutor(): ProcExecutor {
  return {
    async exec(request: ProcRequest): Promise<ProcResult> {
      const req = procRequestSchema.parse(request);
      const env = req.env ?? (processEnv() as Record<string, string>);

      if (req.stdio === "inherit") {
        // Terminal-attached: wire the caller's stdio straight through. Local
        // only — a remote executor can't fulfill this without PTY forwarding.
        return await new Promise<ProcResult>((resolve) => {
          const child = spawn(req.command, [...req.args], {
            cwd: req.cwd,
            env,
            stdio: "inherit",
            ...(req.timeoutMs ? { timeout: req.timeoutMs } : {}),
          });
          child.on("error", () =>
            resolve({ status: 1, stdout: "", stderr: "", signal: null }),
          );
          child.on("close", (status, signal) =>
            resolve({
              status: statusOf(status, signal),
              stdout: "",
              stderr: "",
              signal: signal ?? null,
            }),
          );
        });
      }

      const captured = await streamCapture([req.command, ...req.args], {
        cwd: req.cwd,
        env,
        ...(req.stdin !== undefined ? { stdin: req.stdin } : {}),
        ...(req.timeoutMs ? { timeout: req.timeoutMs } : {}),
      });
      return {
        status: statusOf(captured.status, captured.signal),
        stdout: captured.stdout,
        stderr: captured.stderr,
        signal: captured.signal,
      };
    },
  };
}
