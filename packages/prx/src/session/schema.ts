/**
 * Session-open actor contract (GH-2027).
 *
 * The `session_open` actor is the schema-bound entry point for every
 * `prx <actor> session` verb (`plan`, `implement`, `intake`, `triage`,
 * `submit`, `author`). It composes the existing `prx workspace`
 * primitives (`reserve` → `prepare`) with the `sessionEntryMachine`
 * profile-build step so each verb spawns into its own worktree on
 * disk instead of inheriting the operator's cwd (typically `mainx`).
 *
 * This module owns the Zod contract; the orchestrator (`open.ts`)
 * and machine (`../machine/machines/session-open.ts`) consume these
 * types. Keep this module driver-agnostic — no `worktrunk`, no
 * `tmux`, no `claude` vocabulary leaks here.
 *
 * Invariants (matching `invariantSpecs` in `src/machine/state.ts`):
 *   I-SO1  Every `prx <actor> session` verb routes through the
 *          `session_open` actor — direct dispatch into
 *          `sessionEntryMachine` from CLI handlers is forbidden.
 *   I-SO2  `intake` and `triage` session-open MUST derive a fresh
 *          `(yyyymmdd, shortId)` per call — no reuse of an existing
 *          workspace_id across invocations.
 *   I-SO3  Every `SESSION_OPEN_*` event carries `workspace_id`
 *          (when known) + `uow_id`. Grounds I-AUD1/I-AUD2/I-AUD4.
 */

import { z } from "zod";

import {
  Lifecycle,
  PrepareOutput,
  ReserveOutput,
  WorkspaceId,
} from "../workspace/schema.ts";

/**
 * The session-open verbs. Source of truth for the per-actor
 * branch-naming convention (`deriveSessionBranch`) and per-actor
 * lifecycle phase mapping (see `actorLifecycle` in `open.ts`).
 *
 * GH-2394: `scratch` is registered here for vocabulary completeness, but it is
 * work-unit-UNBOUND and does NOT route through `openSession` — it never
 * reserves/prepares a worktree (it launches in the current cwd) and dispatches
 * directly via `OPEN_SCRATCH_SESSION`. The `actorLifecycle`/`buildSessionEntryEvent`
 * sites in `open.ts` therefore treat it as a non-openSession actor.
 */
export const SessionActor = z.enum([
  "plan",
  "implement",
  "intake",
  "triage",
  "submit",
  "author",
  "scratch",
]);
export type SessionActor = z.infer<typeof SessionActor>;

/**
 * Input contract for `openSession()`. `workUnitId` is required for
 * the four work-unit-bound verbs (plan/implement/submit/author);
 * intake/triage are unbound and generate a fresh
 * `<actor>/<yyyymmdd>-<short>` branch per call.
 */
export const SessionOpenInput = z
  .object({
    actor: SessionActor,
    workUnitId: z.string().min(1).optional(),
    hasPriorSession: z.boolean().default(false),
    planPath: z.string().optional(),
    planBody: z.string().optional(),
    // GH-2380: headless-first axis forwarded onto the session-entry event so
    // the dispatched profile carries the right (headless SDK / interactive
    // tmux) shape. Absent ⇒ headless (the default for every agent mode).
    interaction: z.enum(["headless", "interactive"]).optional(),
    shortId: z
      .string()
      .regex(/^[a-z0-9]{5,8}$/)
      .optional(),
    now: z.string().datetime().optional(),
  })
  .refine(
    (v) =>
      v.actor === "intake" ||
      v.actor === "triage" ||
      v.actor === "scratch" ||
      v.workUnitId != null,
    {
      message: "workUnitId required for plan/implement/submit/author",
      path: ["workUnitId"],
    },
  );
export type SessionOpenInput = z.infer<typeof SessionOpenInput>;

/**
 * Output contract for `openSession()`. The CLI dispatcher reads
 * `worktree_path` to set the spawned profile's cwd, and `status`
 * to decide whether to launch Claude at all.
 */
export const SessionOpenOutput = z.object({
  workspace_id: WorkspaceId,
  worktree_path: z.string(),
  branch_ref: z.string(),
  lifecycle: Lifecycle,
  reserved_status: ReserveOutput.shape.status,
  prepared_status: PrepareOutput.shape.status,
  profile_built: z.boolean(),
  status: z.enum(["opened", "error"]),
  stage: z
    .enum(["naming", "reserve", "materialize", "prepare", "dispatch"])
    .optional(),
  error: z.string().optional(),
});
export type SessionOpenOutput = z.infer<typeof SessionOpenOutput>;

/**
 * Per-actor session-open verb tuple. Parallel to `WORKSPACE_VERBS`
 * in `src/workspace/schema.ts` — used by the `prx model` / `prx
 * graph` projections and by the `session_open` actor's `accepts`
 * registration in `src/machine/actors.ts`.
 */
export const SESSION_OPEN_VERBS = SessionActor.options;
export type SessionOpenVerb = SessionActor;
