/**
 * GH-2027 — session-open contract + machine tests.
 *
 * Covers:
 *   - `deriveSessionBranch` per-actor naming convention (intake/triage
 *     → `<actor>/<yyyymmdd>-<short>`; work-unit-bound → workUnitId).
 *   - I-SO2: parallel intake calls generate distinct branches (fresh
 *     CSPRNG short id per call).
 *   - `SessionOpenInput` Zod refinement: workUnitId required for the
 *     four work-unit-bound actors, optional for intake/triage.
 *   - `sessionOpenMachine` happy-path transitions through every state.
 *   - `sessionOpenMachine` failure transitions at every stage; no
 *     profile recorded on failure.
 *   - `openSession` end-to-end with stubbed reserve/prepare/dispatch:
 *     happy-path returns status="opened" + the recorded events; a
 *     reserve-error short-circuits before chdir + prepare + dispatch.
 */

import { describe, expect, test } from "bun:test";
import { createActor } from "xstate";

import {
  sessionOpenMachine,
  type SessionOpenContext,
} from "../../src/machine/machines/session-open.ts";
import {
  SessionOpenInput,
  type SessionActor,
} from "../../src/session/schema.ts";
import {
  deriveSessionBranch,
  openSession,
} from "../../src/session/open.ts";
import type { RuntimeProfileProjection } from "../../src/machine/runtime_profiles.ts";

function startMachine() {
  const actor = createActor(sessionOpenMachine);
  actor.start();
  return actor;
}

function snapshot(actor: ReturnType<typeof startMachine>): {
  value: unknown;
  context: SessionOpenContext;
} {
  const snap = actor.getSnapshot();
  return { value: snap.value, context: snap.context };
}

// ---------------------------------------------------------------------------
// deriveSessionBranch
// ---------------------------------------------------------------------------

describe("deriveSessionBranch", () => {
  test("intake → intake/<yyyymmdd>-<short>", () => {
    const branch = deriveSessionBranch({
      actor: "intake",
      shortId: "rkg1w0",
      now: "2026-05-18T12:00:00Z",
    });
    expect(branch).toBe("intake/20260518-rkg1w0");
  });

  test("triage → triage/<yyyymmdd>-<short>", () => {
    const branch = deriveSessionBranch({
      actor: "triage",
      shortId: "z9p3aa",
      now: "2026-05-18T00:00:00Z",
    });
    expect(branch).toBe("triage/20260518-z9p3aa");
  });

  test("plan → <workUnitId>", () => {
    expect(
      deriveSessionBranch({ actor: "plan", workUnitId: "GH-2027" }),
    ).toBe("GH-2027");
  });

  test("implement|submit|author all reuse workUnitId", () => {
    for (const actor of ["implement", "submit", "author"] as const) {
      expect(
        deriveSessionBranch({ actor, workUnitId: "GH-2027" }),
      ).toBe("GH-2027");
    }
  });

  test("plan without workUnitId throws", () => {
    expect(() => deriveSessionBranch({ actor: "plan" })).toThrow(
      /workUnitId required/,
    );
  });

  test("I-SO2: two intake calls produce distinct branches (fresh short id)", () => {
    const a = deriveSessionBranch({ actor: "intake" });
    const b = deriveSessionBranch({ actor: "intake" });
    expect(a).not.toBe(b);
    expect(a).toMatch(/^intake\/\d{8}-[0-9a-f]{6}$/);
    expect(b).toMatch(/^intake\/\d{8}-[0-9a-f]{6}$/);
  });
});

// ---------------------------------------------------------------------------
// SessionOpenInput Zod refinement
// ---------------------------------------------------------------------------

describe("SessionOpenInput", () => {
  test("rejects plan without workUnitId", () => {
    const result = SessionOpenInput.safeParse({ actor: "plan" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) =>
          /workUnitId required/.test(i.message),
        ),
      ).toBe(true);
    }
  });

  test("accepts intake without workUnitId", () => {
    const result = SessionOpenInput.safeParse({ actor: "intake" });
    expect(result.success).toBe(true);
  });

  test("accepts triage without workUnitId", () => {
    const result = SessionOpenInput.safeParse({ actor: "triage" });
    expect(result.success).toBe(true);
  });

  test("accepts plan/implement/submit/author with workUnitId", () => {
    for (const actor of ["plan", "implement", "submit", "author"] as const) {
      const result = SessionOpenInput.safeParse({
        actor,
        workUnitId: "GH-2027",
      });
      expect(result.success).toBe(true);
    }
  });

  test("rejects malformed shortId", () => {
    const result = SessionOpenInput.safeParse({
      actor: "intake",
      shortId: "TOO-LONG-AND-INVALID",
    });
    expect(result.success).toBe(false);
  });

  test("accepts valid shortId", () => {
    const result = SessionOpenInput.safeParse({
      actor: "intake",
      shortId: "rkg1w0",
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sessionOpenMachine — happy path
// ---------------------------------------------------------------------------

describe("sessionOpenMachine — happy path", () => {
  test("idle → naming → reserving → materializing → preparing → dispatching → opened", () => {
    const actor = startMachine();
    expect(snapshot(actor).value).toBe("idle");

    actor.send({
      type: "SESSION_OPEN_REQUESTED",
      actor: "intake",
    });
    expect(snapshot(actor).value).toBe("naming");
    expect(snapshot(actor).context.actor).toBe("intake");

    actor.send({
      type: "SESSION_OPEN_NAME_DERIVED",
      branch: "intake/20260518-rkg1w0",
      lifecycle: "materialized",
    });
    expect(snapshot(actor).value).toBe("reserving");
    expect(snapshot(actor).context.branch).toBe("intake/20260518-rkg1w0");
    expect(snapshot(actor).context.lifecycle).toBe("materialized");

    actor.send({
      type: "SESSION_OPEN_RESERVED",
      workspaceId: "deadbeef0000",
      reservedStatus: "created",
    });
    expect(snapshot(actor).value).toBe("materializing");
    expect(snapshot(actor).context.workspaceId).toBe("deadbeef0000");
    expect(snapshot(actor).context.reservedStatus).toBe("created");

    actor.send({
      type: "SESSION_OPEN_MATERIALIZED",
      worktreePath: "/tmp/wt/intake",
    });
    expect(snapshot(actor).value).toBe("preparing");
    expect(snapshot(actor).context.worktreePath).toBe("/tmp/wt/intake");

    actor.send({
      type: "SESSION_OPEN_PREPARED",
      preparedStatus: "ok",
    });
    expect(snapshot(actor).value).toBe("dispatching");
    expect(snapshot(actor).context.preparedStatus).toBe("ok");

    const stubProfile = { profile: "intake" } as unknown as RuntimeProfileProjection;
    actor.send({
      type: "SESSION_OPEN_DISPATCHED",
      profile: stubProfile,
    });
    expect(snapshot(actor).value).toBe("opened");
    expect(snapshot(actor).context.profile).toBe(stubProfile);
  });
});

// ---------------------------------------------------------------------------
// sessionOpenMachine — failure branches
// ---------------------------------------------------------------------------

describe("sessionOpenMachine — failure paths", () => {
  test("FAILED at naming → failed_naming; no profile recorded", () => {
    const actor = startMachine();
    actor.send({ type: "SESSION_OPEN_REQUESTED", actor: "plan" });
    actor.send({
      type: "SESSION_OPEN_FAILED",
      stage: "naming",
      error: "workUnitId required",
    });
    expect(snapshot(actor).value).toBe("failed_naming");
    expect(snapshot(actor).context.failedStage).toBe("naming");
    expect(snapshot(actor).context.profile).toBeUndefined();
  });

  test("FAILED at reserve → failed_reserve; no profile recorded", () => {
    const actor = startMachine();
    actor.send({ type: "SESSION_OPEN_REQUESTED", actor: "intake" });
    actor.send({
      type: "SESSION_OPEN_NAME_DERIVED",
      branch: "intake/20260518-rkg1w0",
      lifecycle: "materialized",
    });
    actor.send({
      type: "SESSION_OPEN_FAILED",
      stage: "reserve",
      error: "git: branch creation failed",
    });
    expect(snapshot(actor).value).toBe("failed_reserve");
    expect(snapshot(actor).context.profile).toBeUndefined();
  });

  test("FAILED at materialize → failed_materialize; no profile recorded", () => {
    const actor = startMachine();
    actor.send({ type: "SESSION_OPEN_REQUESTED", actor: "intake" });
    actor.send({
      type: "SESSION_OPEN_NAME_DERIVED",
      branch: "intake/20260518-rkg1w0",
      lifecycle: "materialized",
    });
    actor.send({
      type: "SESSION_OPEN_RESERVED",
      workspaceId: "deadbeef0000",
      reservedStatus: "created",
    });
    expect(snapshot(actor).value).toBe("materializing");
    actor.send({
      type: "SESSION_OPEN_FAILED",
      stage: "materialize",
      error: "git worktree add failed",
    });
    expect(snapshot(actor).value).toBe("failed_materialize");
    expect(snapshot(actor).context.failedStage).toBe("materialize");
    expect(snapshot(actor).context.profile).toBeUndefined();
  });

  test("FAILED at prepare → failed_prepare; no profile recorded", () => {
    const actor = startMachine();
    actor.send({ type: "SESSION_OPEN_REQUESTED", actor: "intake" });
    actor.send({
      type: "SESSION_OPEN_NAME_DERIVED",
      branch: "intake/20260518-rkg1w0",
      lifecycle: "materialized",
    });
    actor.send({
      type: "SESSION_OPEN_RESERVED",
      workspaceId: "deadbeef0000",
      reservedStatus: "created",
    });
    actor.send({
      type: "SESSION_OPEN_MATERIALIZED",
      worktreePath: "/tmp/wt/intake",
    });
    actor.send({
      type: "SESSION_OPEN_FAILED",
      stage: "prepare",
      error: "exclude write failed",
    });
    expect(snapshot(actor).value).toBe("failed_prepare");
    expect(snapshot(actor).context.profile).toBeUndefined();
  });

  test("FAILED at dispatch → failed_dispatch; profile is undefined", () => {
    const actor = startMachine();
    actor.send({ type: "SESSION_OPEN_REQUESTED", actor: "intake" });
    actor.send({
      type: "SESSION_OPEN_NAME_DERIVED",
      branch: "intake/20260518-rkg1w0",
      lifecycle: "materialized",
    });
    actor.send({
      type: "SESSION_OPEN_RESERVED",
      workspaceId: "deadbeef0000",
      reservedStatus: "created",
    });
    actor.send({
      type: "SESSION_OPEN_MATERIALIZED",
      worktreePath: "/tmp/wt/intake",
    });
    actor.send({
      type: "SESSION_OPEN_PREPARED",
      preparedStatus: "ok",
    });
    actor.send({
      type: "SESSION_OPEN_FAILED",
      stage: "dispatch",
      error: "machine returned no profile",
    });
    expect(snapshot(actor).value).toBe("failed_dispatch");
    expect(snapshot(actor).context.profile).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// openSession orchestrator — stubbed seams
// ---------------------------------------------------------------------------

type Recorded = { event: string; details?: Record<string, unknown> | undefined; workUnitId?: string | undefined };

function makeRecorder() {
  const recorded: Recorded[] = [];
  const recordEvent = ((
    event: string,
    opts?: { workUnitId?: string; details?: Record<string, unknown> },
  ) => {
    recorded.push({
      event,
      workUnitId: opts?.workUnitId,
      details: opts?.details,
    });
  }) as unknown as Parameters<typeof openSession>[1] extends infer T
    ? T extends { recordEvent?: infer R }
      ? R
      : never
    : never;
  return { recorded, recordEvent };
}

function stubProfile(): RuntimeProfileProjection {
  return { profile: "stub-profile" } as unknown as RuntimeProfileProjection;
}

describe("openSession — happy path", () => {
  test("intake: emits REQUESTED → NAME_DERIVED → RESERVED → PREPARED → DISPATCHED", async () => {
    const { recorded, recordEvent } = makeRecorder();
    const chdirCalls: string[] = [];
    const result = await openSession(
      {
        actor: "intake",
        shortId: "rkg1w0",
        now: "2026-05-18T00:00:00Z",
      },
      {
        runReserve: () => ({
          workspace_id: "deadbeef0000",
          branch_ref: "intake/20260518-rkg1w0",
          status: "created",
        }),
        runMaterialize: () => ({
          workspace_id: "deadbeef0000",
          worktree_path: "/tmp/wt/intake",
          branch: "intake/20260518-rkg1w0",
          status: "created",
        }),
        runPrepare: () => ({
          workspace_id: "deadbeef0000",
          files_written: [],
          beads_hydrated: false,
          status: "ok",
        }),
        dispatchSessionEntry: () => stubProfile(),
        chdir: (p) => {
          chdirCalls.push(p);
        },
        cwd: () => "/tmp/wt/intake",
        recordEvent,
      },
    );
    expect(result.status).toBe("opened");
    expect(result.profile_built).toBe(true);
    expect(result.workspace_id).toBe("deadbeef0000");
    expect(result.worktree_path).toBe("/tmp/wt/intake");
    expect(result.reserved_status).toBe("created");
    expect(result.prepared_status).toBe("ok");
    expect(result.lifecycle).toBe("materialized");
    expect(chdirCalls).toEqual(["/tmp/wt/intake"]);
    const emitted = recorded.map((r) => r.event);
    expect(emitted).toEqual([
      "SESSION_OPEN_REQUESTED",
      "SESSION_OPEN_NAME_DERIVED",
      "SESSION_OPEN_RESERVED",
      "SESSION_OPEN_MATERIALIZED",
      "SESSION_OPEN_PREPARED",
      "SESSION_OPEN_DISPATCHED",
    ]);
  });

  test("plan: lifecycle=attached, branch=workUnitId", async () => {
    const { recorded, recordEvent } = makeRecorder();
    const result = await openSession(
      {
        actor: "plan",
        workUnitId: "GH-2027",
      },
      {
        runReserve: () => ({
          workspace_id: "deadbeef0000",
          branch_ref: "GH-2027",
          status: "exists-local",
        }),
        runMaterialize: () => ({
          workspace_id: "deadbeef0000",
          worktree_path: "/tmp/wt/plan",
          branch: "GH-2027",
          status: "created",
        }),
        runPrepare: () => ({
          workspace_id: "deadbeef0000",
          files_written: [],
          beads_hydrated: true,
          status: "ok",
        }),
        dispatchSessionEntry: () => stubProfile(),
        chdir: () => {},
        cwd: () => "/tmp/wt/plan",
        recordEvent,
      },
    );
    expect(result.lifecycle).toBe("attached");
    expect(result.branch_ref).toBe("GH-2027");
    expect(result.reserved_status).toBe("exists-local");
    const nameEvent = recorded.find(
      (r) => r.event === "SESSION_OPEN_NAME_DERIVED",
    );
    expect(nameEvent?.details).toMatchObject({ branch: "GH-2027" });
  });
});

describe("openSession — PRX_SESSION_NO_LAUNCH (prx-r2w)", () => {
  test("stops at PREPARED: status='prepared', no profile built, no dispatch", async () => {
    const { recorded, recordEvent } = makeRecorder();
    let dispatched = false;
    const prev = process.env.PRX_SESSION_NO_LAUNCH;
    process.env.PRX_SESSION_NO_LAUNCH = "1";
    try {
      const result = await openSession(
        {
          actor: "triage",
          shortId: "rkg1w0",
          now: "2026-05-18T00:00:00Z",
        },
        {
          runReserve: () => ({
            workspace_id: "deadbeef0000",
            branch_ref: "triage/20260518-rkg1w0",
            status: "created",
          }),
          runMaterialize: () => ({
            workspace_id: "deadbeef0000",
            worktree_path: "/tmp/wt/triage",
            branch: "triage/20260518-rkg1w0",
            status: "created",
          }),
          runPrepare: () => ({
            workspace_id: "deadbeef0000",
            files_written: ["/tmp/wt/triage/.beads/redirect"],
            beads_hydrated: false,
            status: "ok",
          }),
          dispatchSessionEntry: () => {
            dispatched = true;
            return stubProfile();
          },
          chdir: () => {},
          cwd: () => "/tmp/wt/triage",
          recordEvent,
        },
      );
      // The materialize→prepare path completed (the worktree and its
      // `.beads/redirect` exist), but the no-launch contract stops before
      // dispatch: no agent profile is built. In xstate terms this is the
      // sessionOpenMachine resting at PREPARED — it never transitions to
      // DISPATCHED. The release smoke harness leans on exactly this to assert
      // the materialize→redirect path with no claude / PTY / agent-SDK.
      expect(result.status).toBe("prepared");
      expect(result.profile_built).toBe(false);
      expect(result.prepared_status).toBe("ok");
      expect(result.worktree_path).toBe("/tmp/wt/triage");
      expect(dispatched).toBe(false);
      const emitted = recorded.map((r) => r.event);
      expect(emitted).toEqual([
        "SESSION_OPEN_REQUESTED",
        "SESSION_OPEN_NAME_DERIVED",
        "SESSION_OPEN_RESERVED",
        "SESSION_OPEN_MATERIALIZED",
        "SESSION_OPEN_PREPARED",
      ]);
      expect(emitted).not.toContain("SESSION_OPEN_DISPATCHED");
    } finally {
      if (prev === undefined) delete process.env.PRX_SESSION_NO_LAUNCH;
      else process.env.PRX_SESSION_NO_LAUNCH = prev;
    }
  });
});

describe("openSession — failure branches", () => {
  test("reserve failure short-circuits before chdir/prepare/dispatch", async () => {
    const { recorded, recordEvent } = makeRecorder();
    let chdirCalled = false;
    let materializeCalled = false;
    let prepareCalled = false;
    let dispatchCalled = false;
    const result = await openSession(
      {
        actor: "intake",
        shortId: "rkg1w0",
        now: "2026-05-18T00:00:00Z",
      },
      {
        runReserve: () => ({
          workspace_id: "deadbeef0000",
          branch_ref: "intake/20260518-rkg1w0",
          status: "error",
          error: "ensureBranch returned error",
        }),
        runMaterialize: () => {
          materializeCalled = true;
          throw new Error("materialize should not be called");
        },
        runPrepare: () => {
          prepareCalled = true;
          throw new Error("prepare should not be called");
        },
        dispatchSessionEntry: () => {
          dispatchCalled = true;
          throw new Error("dispatch should not be called");
        },
        chdir: () => {
          chdirCalled = true;
        },
        cwd: () => "/tmp/wt/intake",
        recordEvent,
      },
    );
    expect(result.status).toBe("error");
    expect(result.stage).toBe("reserve");
    expect(result.profile_built).toBe(false);
    expect(chdirCalled).toBe(false);
    expect(materializeCalled).toBe(false);
    expect(prepareCalled).toBe(false);
    expect(dispatchCalled).toBe(false);
    const emitted = recorded.map((r) => r.event);
    expect(emitted).toContain("SESSION_OPEN_FAILED");
    expect(emitted).not.toContain("SESSION_OPEN_PREPARED");
    expect(emitted).not.toContain("SESSION_OPEN_DISPATCHED");
  });

  test("I-WS5: a materialized mainx worktree fails closed at materialize before chdir/prepare/dispatch", async () => {
    const { recorded, recordEvent } = makeRecorder();
    let chdirCalled = false;
    let prepareCalled = false;
    let dispatchCalled = false;
    const result = await openSession(
      {
        actor: "intake",
        shortId: "rkg1w0",
        now: "2026-05-18T00:00:00Z",
      },
      {
        runReserve: () => ({
          workspace_id: "deadbeef0000",
          branch_ref: "intake/20260518-rkg1w0",
          status: "created",
        }),
        // materialize regresses and resolves the worktree to the read-only
        // mainx replica — the I-WS5 backstop must catch it before chdir.
        runMaterialize: () => ({
          workspace_id: "deadbeef0000",
          worktree_path: "/tmp/wt/worktrees/main/mainx",
          branch: "intake/20260518-rkg1w0",
          status: "created",
        }),
        runPrepare: () => {
          prepareCalled = true;
          throw new Error("prepare should not be called");
        },
        dispatchSessionEntry: () => {
          dispatchCalled = true;
          throw new Error("dispatch should not be called");
        },
        chdir: () => {
          chdirCalled = true;
        },
        cwd: () => "/tmp/wt/worktrees/main/mainx",
        recordEvent,
      },
    );
    expect(result.status).toBe("error");
    expect(result.stage).toBe("materialize");
    expect(result.error).toMatch(/read-only mainx replica/);
    expect(result.profile_built).toBe(false);
    expect(chdirCalled).toBe(false);
    expect(prepareCalled).toBe(false);
    expect(dispatchCalled).toBe(false);
    const emitted = recorded.map((r) => r.event);
    expect(emitted).toContain("SESSION_OPEN_FAILED");
    // reserve succeeded; the guard fires at materialize, before chdir/MATERIALIZED.
    expect(emitted).toContain("SESSION_OPEN_RESERVED");
    expect(emitted).not.toContain("SESSION_OPEN_MATERIALIZED");
    expect(emitted).not.toContain("SESSION_OPEN_PREPARED");
    expect(emitted).not.toContain("SESSION_OPEN_DISPATCHED");
  });

  test("Zod validation failure throws", async () => {
    const { recordEvent } = makeRecorder();
    let threw = false;
    try {
      await openSession(
        { actor: "plan" },
        {
          runReserve: () => ({
            workspace_id: "deadbeef0000",
            branch_ref: "",
            status: "created",
          }),
          runPrepare: () => ({
            workspace_id: "deadbeef0000",
            files_written: [],
            beads_hydrated: false,
            status: "ok",
          }),
          dispatchSessionEntry: () => stubProfile(),
          chdir: () => {},
          cwd: () => "/tmp/wt",
          recordEvent,
        },
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("prepare failure short-circuits dispatch", async () => {
    const { recorded, recordEvent } = makeRecorder();
    let dispatchCalled = false;
    const result = await openSession(
      {
        actor: "intake",
        shortId: "rkg1w0",
        now: "2026-05-18T00:00:00Z",
      },
      {
        runReserve: () => ({
          workspace_id: "deadbeef0000",
          branch_ref: "intake/20260518-rkg1w0",
          status: "created",
        }),
        runMaterialize: () => ({
          workspace_id: "deadbeef0000",
          worktree_path: "/tmp/wt/intake",
          branch: "intake/20260518-rkg1w0",
          status: "created",
        }),
        runPrepare: () => ({
          workspace_id: "deadbeef0000",
          files_written: [],
          beads_hydrated: false,
          status: "error",
          error: "exclude write failed",
        }),
        dispatchSessionEntry: () => {
          dispatchCalled = true;
          throw new Error("dispatch should not be called");
        },
        chdir: () => {},
        cwd: () => "/tmp/wt/intake",
        recordEvent,
      },
    );
    expect(result.status).toBe("error");
    expect(result.stage).toBe("prepare");
    expect(dispatchCalled).toBe(false);
    const emitted = recorded.map((r) => r.event);
    expect(emitted).toContain("SESSION_OPEN_FAILED");
    expect(emitted).not.toContain("SESSION_OPEN_DISPATCHED");
  });
});

// ---------------------------------------------------------------------------
// Actor catalog sanity (I-SO3 wiring check)
// ---------------------------------------------------------------------------

describe("session_open actor registration", () => {
  test("every SESSION_OPEN_* event has an owner in eventOwnerMap", async () => {
    const { eventOwnerMap } = await import("../../src/machine/actors.ts");
    const events = [
      "SESSION_OPEN_REQUESTED",
      "SESSION_OPEN_NAME_DERIVED",
      "SESSION_OPEN_RESERVED",
      "SESSION_OPEN_MATERIALIZED",
      "SESSION_OPEN_PREPARED",
      "SESSION_OPEN_DISPATCHED",
      "SESSION_OPEN_FAILED",
    ];
    for (const evt of events) {
      expect(eventOwnerMap[evt]).toBe("session_open");
    }
  });

  test("session_open actor declares all seven emits", async () => {
    const { toolActorCatalog } = await import("../../src/machine/actors.ts");
    const spec = toolActorCatalog.session_open;
    expect(spec.emits).toContain("SESSION_OPEN_REQUESTED");
    expect(spec.emits).toContain("SESSION_OPEN_NAME_DERIVED");
    expect(spec.emits).toContain("SESSION_OPEN_RESERVED");
    expect(spec.emits).toContain("SESSION_OPEN_MATERIALIZED");
    expect(spec.emits).toContain("SESSION_OPEN_PREPARED");
    expect(spec.emits).toContain("SESSION_OPEN_DISPATCHED");
    expect(spec.emits).toContain("SESSION_OPEN_FAILED");
  });

  test("I-SO1..I-SO3 invariants are registered", async () => {
    const { invariantSpecs } = await import("@bounded-systems/machine-schema");
    const ids = invariantSpecs.map((s) => s.split(":")[0]);
    expect(ids).toContain("I-SO1");
    expect(ids).toContain("I-SO2");
    expect(ids).toContain("I-SO3");
  });
});

// Ensure unused SessionActor import is exercised (keeps imports tight).
const _check: SessionActor = "intake";
void _check;
