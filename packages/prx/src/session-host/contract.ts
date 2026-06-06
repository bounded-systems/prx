/**
 * session-host wire contract (session-substrate slice 1).
 *
 * A `SessionHost` holds a long-running headless agent process alive **inside a
 * Lima VM** (later: a remote Linux host) and lets the host control + observe it
 * over a socket — replacing tmux's *session-holder* role (not the multiplexer).
 * See `docs/prx-session-substrate-decision.md` (ai-home).
 *
 * This module is the **typed wire contract** between the host-side client and
 * the in-VM daemon — a spec-as-schema enforceable boundary: both ends `parse()`
 * every frame, so a malformed request/response is a validation error at the
 * seam, never a silent half-execution. Modelled on the keeperd contract
 * ({@link ../keeperd/contract}).
 *
 * Driver-agnostic: no `limactl`, `ssh`, socket, or systemd vocabulary leaks here
 * — just the request/response shapes. The control plane is location-transparent
 * by construction (same contract for a local Lima VM and a remote host).
 *
 * Slice 1 (this): the contract + the pure in-VM request handler, exercised with
 * injected process/store seams (no VM, no real processes). Slice 2 wraps it in
 * the keeperd frame/serve transport; slice 3 deploys it into Lima; slice 4 wires
 * `prx session open` to dial it; slice 5 prunes tmux.
 */

import { z } from "zod";

/** Lifecycle state of a held session, derived from process liveness. */
export const SESSION_STATES = ["running", "exited", "unknown"] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/** Session id: non-empty and filesystem-safe (it names the pidfile + log). */
const SessionId = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9._-]+$/, "session id must match [A-Za-z0-9._-]");

/**
 * A held session as the daemon reports it. `pid` is the in-VM supervisor's
 * child; `state` is reconciled against liveness on every read, so a session that
 * died out-of-band reads `exited` without the daemon having to watch it.
 */
export const SessionRecordSchema = z.object({
  id: SessionId,
  /** OS pid of the held process inside the VM. */
  pid: z.number().int().positive(),
  state: z.enum(SESSION_STATES),
  /** Exit code once known (`state==="exited"`); absent while running. */
  exitCode: z.number().int().optional(),
  /** argv[0] of the held process — for display/audit. */
  command: z.string().min(1),
  /** Absolute path to the session's append-only output log (tailed for the stream). */
  logPath: z.string().min(1),
  /** ISO 8601 start time. */
  startedAt: z.string().min(1),
});
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

/**
 * One control request. A discriminated union on `kind` — `start` holds a new
 * process; `status`/`list` observe; `stop` signals. (Output streaming is a log
 * tail over the same channel, not a request — see slice 2.)
 */
export const SessionRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("start"),
    id: SessionId,
    /** Program to run (resolved on the VM's PATH). */
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    /** Extra env for the held process (merged over the daemon's). */
    env: z.record(z.string(), z.string()).optional(),
    /** Working directory inside the VM. */
    cwd: z.string().min(1).optional(),
  }),
  z.object({ kind: z.literal("status"), id: SessionId }),
  z.object({
    kind: z.literal("stop"),
    id: SessionId,
    /** Signal name (default `SIGTERM`). */
    signal: z.string().min(1).optional(),
  }),
  z.object({ kind: z.literal("list") }),
]);
export type SessionRequest = z.infer<typeof SessionRequestSchema>;

/**
 * The daemon's reply. A discriminated union on `status` so a caller branches
 * exhaustively: `ok` always carries the affected/observed `sessions` (a single
 * record for start/status/stop, all of them for list); `error` carries a
 * machine-branchable `code` plus a human message.
 */
export const SessionResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), sessions: z.array(SessionRecordSchema) }),
  z.object({
    status: z.literal("error"),
    /** Stable, branchable failure class (e.g. `no-such-session`, `already-running`). */
    code: z.string().min(1),
    /** Human-readable detail (safe to log). */
    message: z.string(),
  }),
]);
export type SessionResponse = z.infer<typeof SessionResponseSchema>;
