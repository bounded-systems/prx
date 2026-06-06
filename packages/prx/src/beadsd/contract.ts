/**
 * beadsd wire contract (GH-228, slice 1).
 *
 * `beadsd` is the `bd` (beads) task store run as a capability-isolated daemon
 * inside the Lima VM — the same pattern as keeperd (GH-201), applied to beads.
 * Its rationale is **context-shape, not secret-custody**: the agent QUERIES the
 * daemon for exactly the tasks it needs ("talk to the actor, not the worktree")
 * instead of loading the whole beads DB into context. With the VM holding the
 * repo clone(s), the beads DB co-locates there — the multi-repo story.
 *
 * This module is the typed wire contract between the host-side
 * {@link ./client.IsolatedBeadsClient} and the in-VM daemon. Both ends `parse()`
 * every frame, so a malformed request/response is a validation error at the seam.
 *
 * Slice 1 is **read-only** (`ready`/`list`/`show`) — the safe, high-value subset
 * for shallow context. Writes (`create`/`update`/`close`) come later: they raise
 * concurrency/ownership questions with the dolt-backed store (#228 open question).
 *
 * Driver-agnostic: no `bd`, `limactl`, `ssh`, or socket vocabulary leaks here —
 * just the request/response shapes.
 */

import { z } from "zod";

/**
 * The bounded set of READ ops the agent may ask of beadsd — its capability
 * envelope. A discriminated union so the daemon dispatches exhaustively, and an
 * enumerable allowlist: a kind not listed here cannot be requested.
 */
export const BeadsRequestSchema = z.discriminatedUnion("kind", [
  /** `bd ready` — issues with no open blockers (the agent's available work). */
  z.object({ kind: z.literal("ready") }),
  /** `bd list [--status <s>]` — issues, optionally filtered by status. */
  z.object({ kind: z.literal("list"), status: z.string().min(1).optional() }),
  /** `bd show <id>` — one issue's detail. */
  z.object({ kind: z.literal("show"), id: z.string().min(1) }),
]);
export type BeadsRequest = z.infer<typeof BeadsRequestSchema>;

/** The read kinds beadsd exposes (the envelope), enumerable as an allowlist. */
export const BEADS_REQUEST_KINDS = ["ready", "list", "show"] as const;
export type BeadsRequestKind = (typeof BEADS_REQUEST_KINDS)[number];

/**
 * beadsd's reply. A discriminated union on `status`: `ok` carries the bd result
 * (carried opaquely — the rich bd issue shape is validated by the beads layer,
 * not this contract, so the wire stays decoupled from the bd schema), `error`
 * carries a machine-branchable `code` + a human message.
 */
export const BeadsResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    /** The bd query result (e.g. the issues array / issue object). Opaque here. */
    result: z.unknown(),
  }),
  z.object({
    status: z.literal("error"),
    /** Stable, branchable failure class (e.g. `bd-read`, `not-found`, `bad-request`). */
    code: z.string().min(1),
    /** Human-readable detail (safe to log). */
    message: z.string(),
  }),
]);
export type BeadsResponse = z.infer<typeof BeadsResponseSchema>;
