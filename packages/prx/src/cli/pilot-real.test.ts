import { describe, expect, test } from "bun:test";
import { createActor, waitFor } from "xstate";

import { ed25519Signer, ed25519Verifier, generateEd25519Keypair } from "@bounded-systems/anchored-chain";

import type { NonInteractiveAgentResult } from "../claude/agent_service.ts";
import { createPilotMachine } from "../machine/machines/pilot.ts";
import { verifyStatement } from "../machine/machines/pilot-signing.ts";
import {
  buildRealLegRunner,
  buildRealPilotDeps,
  roleSessionActor,
  wantsRealPilot,
  type OpenSessionFn,
  type RunAgentFn,
} from "./pilot-real.ts";

const okRun = (text: string): NonInteractiveAgentResult => ({
  kind: "success",
  text,
  stdout: text,
  usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  elapsed_ms: 1,
});

describe("real pilot wiring (openSession → headless agent → real signature)", () => {
  test("opens a session per role and signs legs with the real ed25519 key", async () => {
    const kp = generateEd25519Keypair();
    const openedActors: string[] = [];
    const seenCwds: string[] = [];

    const fakeOpen: OpenSessionFn = async ({ actor, workUnitId }) => {
      openedActors.push(actor);
      return { status: "opened", worktree_path: `/wt/${workUnitId}/${actor}`, profile: {} } as unknown as Awaited<
        ReturnType<OpenSessionFn>
      >;
    };
    const fakeRun: RunAgentFn = async (_profile, opts) => {
      seenCwds.push(opts.cwd);
      return okRun(`work in ${opts.cwd}`);
    };

    const runner = buildRealLegRunner({
      openSession: fakeOpen,
      runAgent: fakeRun,
      signer: ed25519Signer(kp.privateKey, kp.keyid),
    });

    const actor = createActor(createPilotMachine(runner), { input: { workUnitId: "GH-9" } }).start();
    const done = await waitFor(actor, (s) => s.status === "done", { timeout: 3000 });

    expect(done.value).toBe("merged");
    // A session was opened per leg, mapped to the canonical actors.
    expect(openedActors).toEqual(["plan", "implement", "implement", "author"]);
    // The agent ran in the worktree openSession returned.
    expect(seenCwds[0]).toBe("/wt/GH-9/plan");

    // The executor leg carries a REAL signature, not the stub.
    const execLink = done.context.chain.find((l) => l.stage === "executor")!;
    expect(execLink.signedBy).toBe(kp.keyid);
    expect(execLink.sig).not.toBe("stub-signature");
    expect(execLink.sig.length).toBeGreaterThan(0);
  });

  test("buildRealPilotDeps also signs the pilot summary with the real key (verifies)", async () => {
    const kp = generateEd25519Keypair();
    const fakeOpen: OpenSessionFn = async ({ workUnitId }) =>
      ({ status: "opened", worktree_path: `/wt/${workUnitId}`, profile: {} }) as unknown as Awaited<ReturnType<OpenSessionFn>>;
    const fakeRun: RunAgentFn = async () => okRun("ok");

    const deps = buildRealPilotDeps({
      openSession: fakeOpen,
      runAgent: fakeRun,
      // Fake the tail's `prx` calls so the real CI gate / merge don't shell out.
      runPrx: async (args) =>
        args[0] === "scout"
          ? { ok: true, stdout: '{"conclusion":"success"}', stderr: "" }
          : { ok: true, stdout: "merged", stderr: "" },
      signer: ed25519Signer(kp.privateKey, kp.keyid),
    });
    const actor = createActor(createPilotMachine(deps), { input: { workUnitId: "GH-1" } }).start();
    const done = await waitFor(actor, (s) => s.status === "done", { timeout: 3000 });

    const summary = done.context.summary!;
    expect(summary.signedBy).toBe(kp.keyid);
    expect(await verifyStatement(ed25519Verifier(kp.publicKey), summary)).toBe(true);
  });

  test("a failed openSession surfaces as a leg failure (machine retreats)", async () => {
    const kp = generateEd25519Keypair();
    let execOpens = 0;
    const fakeOpen: OpenSessionFn = async ({ actor, workUnitId }) => {
      if (actor === "implement" && ++execOpens === 1) {
        return { status: "error", worktree_path: "", profile: undefined } as unknown as Awaited<ReturnType<OpenSessionFn>>;
      }
      return { status: "opened", worktree_path: `/wt/${workUnitId}`, profile: {} } as unknown as Awaited<ReturnType<OpenSessionFn>>;
    };
    const runner = buildRealLegRunner({
      openSession: fakeOpen,
      runAgent: async () => okRun("ok"),
      signer: ed25519Signer(kp.privateKey, kp.keyid),
    });
    const actor = createActor(createPilotMachine(runner), { input: { workUnitId: "GH-2", retreatBudget: 3 } }).start();
    const done = await waitFor(actor, (s) => s.status === "done", { timeout: 3000 });
    expect(done.value).toBe("merged"); // recovered after the retreat
    expect(execOpens).toBeGreaterThanOrEqual(2);
  });

  test("throws when no signer is configured; role map is total", () => {
    expect(() => buildRealLegRunner({ signer: null })).toThrow("must hold a signing key");
    expect(roleSessionActor).toEqual({
      planner: "plan",
      executor: "implement",
      tester: "implement",
      reviewer: "author",
    });
  });

  test("wantsRealPilot reads PRX_PILOT_REAL", () => {
    expect(wantsRealPilot(() => "1")).toBe(true);
    expect(wantsRealPilot(() => "on")).toBe(true);
    expect(wantsRealPilot(() => undefined)).toBe(false);
    expect(wantsRealPilot(() => "0")).toBe(false);
  });

  // GH-261: a leg sets the idle watchdog and emits a MEANINGFUL heartbeat
  // (progress, not a bare ping) so a stall is visible + locatable.
  test("each leg arms the idle watchdog and heartbeats real progress", async () => {
    const kp = generateEd25519Keypair();
    const beats: Array<{ role: string; turns: number; chars: number; last: string; elapsedMs: number; workUnitId: string }> = [];
    let sawTimeoutMs: number | undefined;

    const fakeOpen: OpenSessionFn = async ({ actor, workUnitId }) =>
      ({ status: "opened", worktree_path: `/wt/${workUnitId}/${actor}`, profile: {} }) as unknown as Awaited<
        ReturnType<OpenSessionFn>
      >;
    const fakeRun: RunAgentFn = async (_profile, opts) => {
      sawTimeoutMs = opts.timeoutMs;
      // The leg streams a real assistant turn → the heartbeat must reflect it.
      opts.onStreamEvent?.({ kind: "assistant_text", text: "Editing  packages/prx/src/pr-state/cli.ts now" });
      return okRun("done");
    };

    const runner = buildRealLegRunner({
      openSession: fakeOpen,
      runAgent: fakeRun,
      signer: ed25519Signer(kp.privateKey, kp.keyid),
      legIdleMs: 1234,
      onLegHeartbeat: (b) => beats.push(b),
    });

    const actor = createActor(createPilotMachine(runner), { input: { workUnitId: "GH-9" } }).start();
    await waitFor(actor, (s) => s.status === "done", { timeout: 3000 });

    // The idle watchdog was armed with our threshold (not left unbounded).
    expect(sawTimeoutMs).toBe(1234);
    // Heartbeats carry meaningful progress, not just "alive".
    expect(beats.length).toBeGreaterThan(0);
    const b = beats[0]!;
    expect(b.turns).toBe(1);
    expect(b.chars).toBeGreaterThan(0);
    expect(b.last).toBe("Editing packages/prx/src/pr-state/cli.ts now"); // whitespace-collapsed snippet
    expect(b.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(b.role).toBe("planner"); // first leg
    expect(b.workUnitId).toBe("GH-9");
  });
});
