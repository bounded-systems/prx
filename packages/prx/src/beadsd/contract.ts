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
  /**
   * The parent-child children of an epic. A READ dispatched to the
   * already-allowed `bd dep` subcommand as `bd dep list <id> --direction up
   * --type parent-child --json` — no capability-surface expansion (`bd
   * children` is not on the bd allowlist; `bd dep` is). Door-backs in-box
   * epic-children resolution (prx-zbsi). `result` carries the child edge rows
   * (opaque here; shaped by the beads layer).
   */
  z.object({ kind: z.literal("children"), id: z.string().min(1) }),
  // ── writes (policy-gated; dispatched to `bd` --json) ──
  /**
   * `bd create --type <t> --title <title> [--priority N] [--description d]
   * [--external-ref <url>] [--silent]`. `externalRef` pins a GH/external URL
   * (the reverse-orphan mirror shape); `silent` suppresses bd's output line.
   */
  z.object({
    kind: z.literal("create"),
    issueType: z.string().min(1),
    title: z.string().min(1),
    priority: z.number().int().min(0).max(4).optional(),
    description: z.string().min(1).optional(),
    externalRef: z.string().min(1).optional(),
    silent: z.boolean().optional(),
  }),
  /**
   * `bd update <id> [--status s] [--priority N] [--assignee a] [--type t]
   * [--external-ref <url>] [--notes <text>]` — at least one field. `issueType`
   * retargets the bd type (drift-fix axis sync); `externalRef` (re)links the
   * GH/external mirror (adapter write-back, `prx beads publish`); `notes`
   * appends a note (intake-comment). GH-296: these extend the single-writer
   * surface so the bulk write reconcilers stop reaching host `bd` directly.
   */
  z.object({
    kind: z.literal("update"),
    id: z.string().min(1),
    status: z.string().min(1).optional(),
    priority: z.number().int().min(0).max(4).optional(),
    /** Assignee; empty string clears it (bd assignee semantics). */
    assignee: z.string().optional(),
    issueType: z.string().min(1).optional(),
    /** (Re)link the external mirror URL — `bd update --external-ref <url>`. */
    externalRef: z.string().min(1).optional(),
    /** Append a note — `bd update --notes <text>`. */
    notes: z.string().min(1).optional(),
    /** Retitle — `bd update --title <t>` (GH→bd sync of the canonical title). */
    title: z.string().min(1).optional(),
    /** Rewrite the description — `bd update --description <d>`. */
    description: z.string().min(1).optional(),
    /**
     * Set a metadata field — `bd update --metadata <key=value>` (e.g.
     * `external_refs.notion=<pageId>` for the Notion mirror link).
     */
    metadata: z.string().min(1).optional(),
  }),
  /** `bd close <id> [--reason r]`. */
  z.object({
    kind: z.literal("close"),
    id: z.string().min(1),
    reason: z.string().min(1).optional(),
  }),
  /** `bd reopen <id>` — re-open a closed issue (drift-fix status-axis sync). */
  z.object({
    kind: z.literal("reopen"),
    id: z.string().min(1),
  }),
  /**
   * `bd dep add --type <t> <from> <to>` / `bd dep remove <from> <to>` — the
   * dependency-edge write surface (promote-children parent-child wiring; dedupe
   * edge rewire). GH-296: routes those off host `bd`. `depType` applies to add
   * (e.g. `parent-child`, `blocks`); remove ignores it.
   */
  z.object({
    kind: z.literal("dep"),
    action: z.enum(["add", "remove"]),
    from: z.string().min(1),
    to: z.string().min(1),
    depType: z.string().min(1).optional(),
  }),
]);
export type BeadsRequest = z.infer<typeof BeadsRequestSchema>;

/** The read kinds (unconditional). */
export const BEADS_READ_KINDS = ["ready", "list", "show", "children"] as const;
/** The write kinds (policy-gated single-writer surface; GH-228 slice 5). */
export const BEADS_WRITE_KINDS = ["create", "update", "close", "reopen", "dep"] as const;
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
    /**
     * GH-296: the dataset generation — the served clone's dolt HEAD hash at
     * reply time. A cheap content-addressed etag for the WHOLE bead store:
     * unchanged HEAD ⇒ nothing moved, so callers can serve cached data and
     * sync can short-circuit (no redundant GitHub API calls). Optional — the
     * daemon omits it when it has no HEAD source wired.
     */
    etag: z.string().min(1).optional(),
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
