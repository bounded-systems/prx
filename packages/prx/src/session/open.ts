/**
 * GH-2027 — session-open orchestrator.
 *
 * Schema-bound entry point for the six `prx <actor> session` verbs
 * (`plan`, `implement`, `intake`, `triage`, `submit`, `author`). Each
 * verb's CLI handler shrinks to a single call:
 *
 *     const result = await openSession({ actor: "intake" });
 *     // spawn Claude with cwd: result.worktree_path
 *
 * The orchestrator drives the documentary `sessionOpenMachine`
 * through five phases:
 *
 *   1. naming      — `deriveSessionBranch()` computes the branch name.
 *   2. reserving   — `runReserve()` writes the workspace ledger + branch
 *                    ref (local-only for ephemeral intake/triage so no
 *                    branch reaches GitHub origin — GH-2271).
 *   3. materializing — `runMaterialize()` runs `git worktree add`, putting
 *                    the worktree on disk and recording the authoritative
 *                    `worktree_path`. The orchestrator chdir's into it.
 *   4. preparing   — `runPrepare()` writes `.git/info/exclude` and
 *                    (when lifecycle=attached) hydrates beads.
 *   5. dispatching — `sessionEntryMachine` builds the Claude runtime
 *                    profile for the actor.
 *   6. opened      — final state; caller spawns Claude with the
 *                    profile + cwd.
 *
 * Each transition emits a `SESSION_OPEN_*` audit row via
 * `recordEvent()` (I-SO3 — every event carries workspace_id + uow_id).
 *
 * Invariants (`src/machine/state.ts`):
 *   I-SO1  Every session-open verb routes through this helper.
 *   I-SO2  intake/triage get a fresh CSPRNG short id per call.
 *   I-SO3  Every SESSION_OPEN_* event carries workspace_id + uow_id.
 */

import { randomBytes } from "node:crypto";

import { createActor } from "xstate";

import { getEnv } from "@bounded-systems/env";
import { recordEvent } from "../machine/record_event.ts";
import {
  dispatchSessionEntryEvent,
} from "../pr-state/session-entry/dispatch.ts";
import type {
  SessionEntryEvent,
} from "../machine/machines/session-entry.ts";
import {
  sessionOpenMachine,
  type SessionOpenStage,
} from "../machine/machines/session-open.ts";
import {
  runMaterialize,
  runPrepare,
  runReserve,
} from "../workspace/actor.ts";
import { isMainxPath } from "../pr-state/scope-inference.ts";
import {
  type Lifecycle,
  type MaterializeOutput,
  type PrepareOutput,
  type ReserveOutput,
} from "../workspace/schema.ts";

import type { RuntimeProfileProjection } from "../machine/runtime_profiles.ts";

import {
  SessionOpenInput,
  type SessionActor,
  type SessionOpenOutput,
} from "./schema.ts";

/**
 * `openSession` return shape. Mirrors the Zod-validated
 * `SessionOpenOutput` and additionally carries the runtime profile the
 * dispatch step built, so callers can spawn the agent without a second
 * direct dispatch into `sessionEntryMachine` (I-SO1). `profile` is
 * present iff `status === "opened"`; it is intentionally not part of the
 * Zod `SessionOpenOutput` contract (the projection is a plain TS type,
 * not a schema).
 */
export type OpenSessionResult = SessionOpenOutput & {
  profile?: RuntimeProfileProjection;
};

/**
 * Per-actor lifecycle phase mapping (see plan § "Lifecycle phase").
 *
 *   intake/triage  → `materialized` — no upfront beads hydrate
 *                    (lazy; the verbs operate on demand).
 *   plan/implement/submit/author → `attached` — hydrate beads at
 *                                  session-start so the work-unit
 *                                  graph (predecessors, blockers,
 *                                  parity chain) is loaded.
 *
 * `running` is reserved for future devcontainer/Docker drivers and
 * unused by GH-2027.
 */
const actorLifecycle: Record<SessionActor, Lifecycle> = {
  intake: "materialized",
  triage: "materialized",
  plan: "attached",
  implement: "attached",
  submit: "attached",
  author: "attached",
  // GH-2394: scratch is work-unit-UNBOUND and never routes through
  // `openSession` (no reserve/prepare). The entry exists only to satisfy the
  // `Record<SessionActor, …>` completeness check; "materialized" mirrors the
  // other unbound actors.
  scratch: "materialized",
};

function formatDateStamp(d: Date): string {
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function generateShortId(): string {
  return randomBytes(3).toString("hex");
}

export type DeriveSessionBranchInput = {
  actor: SessionActor;
  workUnitId?: string | undefined;
  shortId?: string | undefined;
  now?: string | undefined;
};

/**
 * Pure: compute the session branch name per the per-actor naming
 * convention (plan § "Naming conventions").
 *
 *   intake|triage         → `<actor>/<yyyymmdd>-<short>`
 *   plan|implement|submit|author → `<workUnitId>`
 *
 * I-SO2: intake/triage MUST get a fresh short id per call. When the
 * caller omits `shortId`, this function generates one from a CSPRNG
 * (`randomBytes(3).toString("hex")`) — never reuses a prior id.
 */
export function deriveSessionBranch(input: DeriveSessionBranchInput): string {
  const actor = input.actor;
  if (actor === "intake" || actor === "triage") {
    const date = input.now ? new Date(input.now) : new Date();
    const stamp = formatDateStamp(date);
    const short = input.shortId ?? generateShortId();
    return `${actor}/${stamp}-${short}`;
  }
  if (!input.workUnitId) {
    throw new Error(
      `deriveSessionBranch: workUnitId required for actor=${actor}`,
    );
  }
  return input.workUnitId;
}

// ---------------------------------------------------------------------------
// dependency seams
// ---------------------------------------------------------------------------

export type OpenSessionDeps = {
  /** Override `runReserve` (tests). */
  runReserve?: typeof runReserve;
  /** Override `runMaterialize` (tests). */
  runMaterialize?: typeof runMaterialize;
  /** Override `runPrepare` (tests). */
  runPrepare?: typeof runPrepare;
  /** Override the session-entry dispatch (tests). */
  dispatchSessionEntry?: typeof dispatchSessionEntryEvent;
  /** Override `process.chdir` (tests). */
  chdir?: (path: string) => void;
  /** Override `process.cwd` (tests). */
  cwd?: () => string;
  /** Inject `recordEvent` (tests). */
  recordEvent?: typeof recordEvent;
};

// ---------------------------------------------------------------------------
// orchestrator
// ---------------------------------------------------------------------------

function buildSessionEntryEvent(
  actor: SessionActor,
  input: {
    workUnitId?: string | undefined;
    hasPriorSession: boolean;
    planPath?: string | undefined;
    planBody?: string | undefined;
    interaction?: "headless" | "interactive" | undefined;
    message?: string | undefined;
  },
): SessionEntryEvent {
  switch (actor) {
    case "intake":
      return {
        type: "OPEN_INTAKE_SESSION",
        interaction: input.interaction,
        message: input.message,
      };
    case "triage":
      return {
        type: "OPEN_TRIAGE_SESSION",
        interaction: input.interaction,
        message: input.message,
      };
    case "plan":
      return {
        type: "OPEN_PLAN_SESSION",
        workUnitId: input.workUnitId!,
        hasPriorSession: input.hasPriorSession,
        planPath: input.planPath,
        // GH-196: thread the headless axis so the autonomous caller
        // (`openSession({ interaction: "headless" })`, e.g. the pilot) reaches
        // the SDK plan builder. Absent → the interactive default (the human
        // `prx plan session` / `session open` tmux path is unchanged).
        interaction: input.interaction,
      };
    case "implement":
      return {
        type: "OPEN_IMPLEMENT_SESSION",
        workUnitId: input.workUnitId!,
        hasPriorSession: input.hasPriorSession,
        planPath: input.planPath,
        planBody: input.planBody,
        // GH-196: see OPEN_PLAN_SESSION. Absent → the interactive
        // `prx implement --interactive` tmux path; "headless" → SDK executor.
        interaction: input.interaction,
      };
    case "submit":
      return {
        type: "OPEN_SUBMIT_SESSION",
        workUnitId: input.workUnitId!,
        hasPriorSession: input.hasPriorSession,
        planPath: input.planPath,
        planBody: input.planBody,
        interaction: input.interaction,
      };
    case "author":
      return {
        type: "OPEN_AUTHOR_SESSION",
        workUnitId: input.workUnitId!,
        hasPriorSession: input.hasPriorSession,
        planPath: input.planPath,
        planBody: input.planBody,
        interaction: input.interaction,
      };
    case "scratch":
      // GH-2394: scratch does NOT route through `openSession` — it is
      // work-unit-UNBOUND, reserves no worktree, and dispatches
      // `OPEN_SCRATCH_SESSION` directly from the CLI with the launch cwd.
      // Reaching here means a caller wired scratch through the session_open
      // orchestrator, which is unsupported.
      throw new Error(
        "openSession does not support actor=scratch; dispatch OPEN_SCRATCH_SESSION directly (work-unit-unbound, no reserve).",
      );
  }
}

/**
 * Schema-bound entry point for the six session-open verbs. Drives
 * `sessionOpenMachine` through naming → reserving → preparing →
 * dispatching → opened, emitting one `SESSION_OPEN_*` audit row per
 * transition.
 *
 * Returns a `SessionOpenOutput` with `status="opened"` on the happy
 * path or `status="error"` with a `stage` field on any failure. The
 * caller MUST check `status` before spawning the agent — on `error`
 * the worktree may not exist and the runtime profile is not built.
 */
export async function openSession(
  rawInput: unknown,
  deps: OpenSessionDeps = {},
): Promise<OpenSessionResult> {
  const input = SessionOpenInput.parse(rawInput);
  const reserveImpl = deps.runReserve ?? runReserve;
  const materializeImpl = deps.runMaterialize ?? runMaterialize;
  const prepareImpl = deps.runPrepare ?? runPrepare;
  const dispatchImpl = deps.dispatchSessionEntry ?? dispatchSessionEntryEvent;
  const chdirImpl = deps.chdir ?? ((p: string) => process.chdir(p));
  const cwdImpl = deps.cwd ?? (() => process.cwd());
  // Capture the launching workspace BEFORE the materialize chdir (line ~429).
  // `prepare` runs post-chdir (cwd === worktree), so the redirect source for a
  // materialized worktree must come from here (prx-jkb).
  const launchCwd = cwdImpl();
  const emit = deps.recordEvent ?? recordEvent;

  const machine = createActor(sessionOpenMachine).start();
  const lifecycle = actorLifecycle[input.actor];

  // -------------------------------------------------------------------------
  // 1. SESSION_OPEN_REQUESTED
  // -------------------------------------------------------------------------
  machine.send({
    type: "SESSION_OPEN_REQUESTED",
    actor: input.actor,
    workUnitId: input.workUnitId,
  });
  emit("SESSION_OPEN_REQUESTED", {
    workUnitId: input.workUnitId,
    details: { actor: input.actor },
  });

  // -------------------------------------------------------------------------
  // 2. naming → NAME_DERIVED | FAILED(naming)
  // -------------------------------------------------------------------------
  let branch: string;
  try {
    branch = deriveSessionBranch({
      actor: input.actor,
      workUnitId: input.workUnitId,
      shortId: input.shortId,
      now: input.now,
    });
  } catch (err) {
    return failAt(
      machine,
      emit,
      "naming",
      err instanceof Error ? err.message : String(err),
      { workUnitId: input.workUnitId },
    );
  }
  machine.send({
    type: "SESSION_OPEN_NAME_DERIVED",
    branch,
    lifecycle,
  });
  emit("SESSION_OPEN_NAME_DERIVED", {
    workUnitId: input.workUnitId,
    details: { actor: input.actor, branch, lifecycle },
  });

  // -------------------------------------------------------------------------
  // 3. reserving → RESERVED | FAILED(reserve)
  // -------------------------------------------------------------------------
  let reserveResult: ReserveOutput;
  try {
    reserveResult = reserveImpl(
      {
        branch,
        base: "origin/main",
        // Ephemeral session branches (intake/triage, lifecycle
        // `materialized`) must never be pushed to GitHub origin
        // (ai-home-rkg1w.1 §3.5 / GH-2271). materialize creates the
        // local branch via `git worktree add`; reserve stays local-only.
        local_only: lifecycle === "materialized",
      },
      cwdImpl(),
    );
  } catch (err) {
    return failAt(
      machine,
      emit,
      "reserve",
      err instanceof Error ? err.message : String(err),
      { workUnitId: input.workUnitId, branch },
    );
  }
  if (reserveResult.status === "error" || reserveResult.status === "base-unresolved") {
    return failAt(
      machine,
      emit,
      "reserve",
      reserveResult.error ?? `reserve ${reserveResult.status}`,
      {
        workUnitId: input.workUnitId,
        workspace_id: reserveResult.workspace_id,
        branch,
        reserved_status: reserveResult.status,
      },
    );
  }

  machine.send({
    type: "SESSION_OPEN_RESERVED",
    workspaceId: reserveResult.workspace_id,
    reservedStatus: reserveResult.status,
  });
  emit("SESSION_OPEN_RESERVED", {
    workUnitId: input.workUnitId,
    details: {
      actor: input.actor,
      workspace_id: reserveResult.workspace_id,
      branch,
      reserved_status: reserveResult.status,
    },
  });

  // -------------------------------------------------------------------------
  // 4. materializing → MATERIALIZED | FAILED(materialize)
  //
  // `runMaterialize` runs `git worktree add` and returns the authoritative
  // `worktree_path` from the ledger (replaces the old broken
  // `resolveWorkspaceContext({cwd, branch})` recovery, which only ever
  // returned the caller's cwd — GH-2271). chdir into the real worktree so
  // `prepare` resolves its excludes/beads against the session tree.
  // -------------------------------------------------------------------------
  let materializeResult: MaterializeOutput;
  try {
    materializeResult = materializeImpl(
      { workspace_id: reserveResult.workspace_id },
      cwdImpl(),
    );
  } catch (err) {
    return failAt(
      machine,
      emit,
      "materialize",
      err instanceof Error ? err.message : String(err),
      {
        workUnitId: input.workUnitId,
        workspace_id: reserveResult.workspace_id,
        branch,
      },
    );
  }
  if (materializeResult.status === "error") {
    return failAt(
      machine,
      emit,
      "materialize",
      materializeResult.error ?? "materialize error",
      {
        workUnitId: input.workUnitId,
        workspace_id: reserveResult.workspace_id,
        branch,
      },
    );
  }
  const worktreePath = materializeResult.worktree_path;
  // I-WS5: fail closed before chdir/prepare/dispatch if the materialized
  // worktree resolves to the read-only mainx replica. Defense-in-depth with
  // the workspace-actor guard (which still catches a poisoned by-id ledger):
  // even if the materialize routing regresses, we never chdir into mainx,
  // never mutate it, and never spawn an agent against it.
  if (isMainxPath(worktreePath)) {
    return failAt(
      machine,
      emit,
      "materialize",
      "refusing to operate on read-only mainx replica — materialize a sibling worktree first",
      {
        workUnitId: input.workUnitId,
        workspace_id: reserveResult.workspace_id,
        branch,
      },
    );
  }
  chdirImpl(worktreePath);
  machine.send({
    type: "SESSION_OPEN_MATERIALIZED",
    worktreePath,
  });
  emit("SESSION_OPEN_MATERIALIZED", {
    workUnitId: input.workUnitId,
    details: {
      actor: input.actor,
      workspace_id: reserveResult.workspace_id,
      worktree_path: worktreePath,
      branch,
      materialized_status: materializeResult.status,
    },
  });

  // -------------------------------------------------------------------------
  // 5. preparing → PREPARED | FAILED(prepare)
  // -------------------------------------------------------------------------
  let prepareResult: PrepareOutput;
  try {
    prepareResult = prepareImpl(
      { workspace_id: reserveResult.workspace_id, lifecycle, launchCwd },
      cwdImpl(),
    );
  } catch (err) {
    return failAt(
      machine,
      emit,
      "prepare",
      err instanceof Error ? err.message : String(err),
      {
        workUnitId: input.workUnitId,
        workspace_id: reserveResult.workspace_id,
        branch,
      },
    );
  }
  if (prepareResult.status === "error") {
    return failAt(
      machine,
      emit,
      "prepare",
      prepareResult.error ?? "prepare error",
      {
        workUnitId: input.workUnitId,
        workspace_id: reserveResult.workspace_id,
        branch,
        prepared_status: prepareResult.status,
      },
    );
  }
  machine.send({
    type: "SESSION_OPEN_PREPARED",
    preparedStatus: prepareResult.status,
  });
  emit("SESSION_OPEN_PREPARED", {
    workUnitId: input.workUnitId,
    details: {
      actor: input.actor,
      workspace_id: reserveResult.workspace_id,
      lifecycle,
      prepared_status: prepareResult.status,
    },
  });

  // prx-r2w: PRX_SESSION_NO_LAUNCH stops here — the worktree is materialized and
  // (for the materialized lifecycle) `.beads/redirect` is written, but no agent
  // profile is built or launched. This lets the release smoke harness assert
  // the materialize→redirect path against the real binary with no claude / PTY /
  // SDK, deterministically and in CI.
  if (getEnv("PRX_SESSION_NO_LAUNCH")) {
    // Machine already recorded SESSION_OPEN_PREPARED above; leave it there.
    return {
      workspace_id: reserveResult.workspace_id,
      worktree_path: worktreePath,
      branch_ref: reserveResult.branch_ref,
      lifecycle,
      reserved_status: reserveResult.status,
      prepared_status: prepareResult.status,
      profile_built: false,
      status: "prepared",
    };
  }

  // -------------------------------------------------------------------------
  // 6. dispatching → DISPATCHED | FAILED(dispatch)
  // -------------------------------------------------------------------------
  let profile;
  try {
    profile = dispatchImpl(
      buildSessionEntryEvent(input.actor, {
        workUnitId: input.workUnitId,
        hasPriorSession: input.hasPriorSession ?? false,
        planPath: input.planPath,
        planBody: input.planBody,
        interaction: input.interaction,
        message: input.message,
      }),
    );
  } catch (err) {
    return failAt(
      machine,
      emit,
      "dispatch",
      err instanceof Error ? err.message : String(err),
      {
        workUnitId: input.workUnitId,
        workspace_id: reserveResult.workspace_id,
        branch,
      },
    );
  }
  machine.send({
    type: "SESSION_OPEN_DISPATCHED",
    profile,
  });
  emit("SESSION_OPEN_DISPATCHED", {
    workUnitId: input.workUnitId,
    details: {
      actor: input.actor,
      workspace_id: reserveResult.workspace_id,
      branch,
      profile: profile.profile ?? "unknown",
    },
  });

  return {
    workspace_id: reserveResult.workspace_id,
    worktree_path: worktreePath,
    branch_ref: reserveResult.branch_ref,
    lifecycle,
    reserved_status: reserveResult.status,
    prepared_status: prepareResult.status,
    profile_built: true,
    status: "opened",
    profile,
  };
}

function failAt(
  machine: ReturnType<typeof createActor<typeof sessionOpenMachine>>,
  emit: typeof recordEvent,
  stage: SessionOpenStage,
  error: string,
  details: Record<string, unknown> & { workUnitId?: string | undefined },
): SessionOpenOutput {
  machine.send({ type: "SESSION_OPEN_FAILED", stage, error });
  const { workUnitId, ...rest } = details;
  emit("SESSION_OPEN_FAILED", {
    workUnitId,
    details: { stage, error, ...rest },
  });
  const ctx = machine.getSnapshot().context;
  return {
    workspace_id: ctx.workspaceId ?? "000000000000",
    worktree_path: ctx.worktreePath ?? "",
    branch_ref: ctx.branch ?? "",
    lifecycle: ctx.lifecycle ?? "materialized",
    reserved_status: ctx.reservedStatus ?? "error",
    prepared_status: ctx.preparedStatus ?? "error",
    profile_built: false,
    status: "error",
    stage,
    error,
  };
}
