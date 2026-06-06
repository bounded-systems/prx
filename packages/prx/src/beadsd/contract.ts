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
 * The bounded set of ops the agent may ask of beadsd — its capability envelope.
 * A discriminated union so the daemon dispatches exhaustively, and an enumerable
 * allowlist: a kind not listed here cannot be requested.
 *
 * Reads (`ready`/`list`/`show`) are unconditional. Writes (`create`/`update`/
 * `close`, GH-228 slice 5) are the single-writer surface: the daemon dispatches
 * them to `bd` under the SAME bd policy layer that gates any bd write
 * (planner-role), so beadsd adds no new authority — it just centralizes the one
 * writer to the in-VM canonical, which is what removes per-clone divergence.
 */
export const BeadsRequestSchema = z.discriminatedUnion("kind", [
  // ── reads ──
  /** `bd ready [--explain]` — issues with no open blockers (the agent's available work). */
  z.object({ kind: z.literal("ready"), explain: z.boolean().optional() }),
  /** `bd list [--status <s>] [--all] [--limit N]` — issues, optionally filtered/expanded. */
  z.object({
    kind: z.literal("list"),
    status: z.string().min(1).optional(),
    /** Include all statuses (the common `bd list --all` reader shape). */
    all: z.boolean().optional(),
    /** Cap the result count (`--limit`; 0 = no cap). */
    limit: z.number().int().min(0).optional(),
  }),
  /** `bd show <id>` — one issue's detail. */
  z.object({ kind: z.literal("show"), id: z.string().min(1) }),
  // ── writes (policy-gated; dispatched to `bd` --json) ──
  /** `bd create --type <t> --title <title> [--priority N] [--description d]`. */
  z.object({
    kind: z.literal("create"),
    issueType: z.string().min(1),
    title: z.string().min(1),
    priority: z.number().int().min(0).max(4).optional(),
    description: z.string().min(1).optional(),
  }),
  /** `bd update <id> [--status s] [--priority N] [--assignee a]` — at least one field. */
  z.object({
    kind: z.literal("update"),
    id: z.string().min(1),
    status: z.string().min(1).optional(),
    priority: z.number().int().min(0).max(4).optional(),
    /** Assignee; empty string clears it (bd assignee semantics). */
    assignee: z.string().optional(),
  }),
  /** `bd close <id> [--reason r]`. */
  z.object({
    kind: z.literal("close"),
    id: z.string().min(1),
    reason: z.string().min(1).optional(),
  }),
]);
export type BeadsRequest = z.infer<typeof BeadsRequestSchema>;

/** The read kinds (unconditional). */
export const BEADS_READ_KINDS = ["ready", "list", "show"] as const;
/** The write kinds (policy-gated single-writer surface; GH-228 slice 5). */
export const BEADS_WRITE_KINDS = ["create", "update", "close"] as const;
/** Every kind beadsd exposes (the envelope), enumerable as an allowlist. */
export const BEADS_REQUEST_KINDS = [...BEADS_READ_KINDS, ...BEADS_WRITE_KINDS] as const;
export type BeadsRequestKind = (typeof BEADS_REQUEST_KINDS)[number];

/** True iff `kind` mutates the store (dispatched under the bd write-policy gate). */
export function isBeadsWriteKind(kind: BeadsRequestKind): boolean {
  return (BEADS_WRITE_KINDS as readonly string[]).includes(kind);
}

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
