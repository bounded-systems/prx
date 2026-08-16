// GH-1194 — dispatch envelope coverage. Each test injects fake invoke +
// writeCas actors via `createDispatchMachine({ ... })` so the state graph
// runs without spawning subprocesses or touching the CAS substrate.

import { describe, expect, test } from "bun:test";
import { createActor, fromPromise } from "xstate";

import {
  canDispatch,
  casUriFor,
  dispatchActors,
  dispatchFailureSchema,
  dispatchRequestSchema,
  dispatchResultSchema,
  defaultDispatchCapabilities,
  MAX_DISPATCH_DEPTH,
  parseCasUri,
  readDispatchDepth,
  type DispatchActor,
  type DispatchFailure,
  type DispatchResult,
} from "../../src/machine/dispatch.ts";
import { getAgentContract } from "../../src/machine/contracts/instances.ts";
import {
  createDispatchMachine,
  isDispatchSuccess,
  type DispatchMachineContext,
  type DispatchMachineInput,
  type InvokeTargetVerbInput,
  type InvokeTargetVerbOutput,
  type WriteCasBlobInput,
  type WriteCasBlobOutput,
} from "../../src/machine/machines/dispatch.ts";

// ── builders ───────────────────────────────────────────────────────────────

const okInvoke = (stdout: Buffer, exitCode = 0, durationMs = 5) =>
  fromPromise<InvokeTargetVerbOutput, InvokeTargetVerbInput>(async () => ({
    stdout,
    exitCode,
    durationMs,
  }));

const failingInvoke = (message: string) =>
  fromPromise<InvokeTargetVerbOutput, InvokeTargetVerbInput>(async () => {
    throw new Error(message);
  });

const okWriteCas = (sha: string, refName: string) =>
  fromPromise<WriteCasBlobOutput, WriteCasBlobInput>(async () => ({
    sha,
    refName,
  }));

const failingWriteCas = (message: string) =>
  fromPromise<WriteCasBlobOutput, WriteCasBlobInput>(async () => {
    throw new Error(message);
  });

const sampleSha = `sha256:${"a".repeat(64)}`;

interface RunResult {
  value: string;
  context: DispatchMachineContext;
  output: DispatchResult | DispatchFailure | undefined;
}

async function runToCompletion(
  machine: ReturnType<typeof createDispatchMachine>,
  input: DispatchMachineInput,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const actor = createActor(machine, { input });
    actor.subscribe({
      complete: () => {
        const snap = actor.getSnapshot();
        resolve({
          value: String(snap.value),
          context: snap.context,
          output: snap.output,
        });
      },
      error: reject,
    });
    actor.start();
  });
}

const baseRequest: DispatchMachineInput = {
  source: "plan",
  target: "scout",
  action: "grep",
  args: { pattern: "mkdtemp" },
  depth: 0,
  // GH-1530 PR-6: dispatch is target-authoritative — the target's
  // `allowedCallers` is the sole gate. scout admits plan, so this is an
  // admitted request; the handler injects this from the ActorSpec registry.
  allowedCallers: ["plan"],
};

// ── canDispatch chokepoint ─────────────────────────────────────────────────

describe("canDispatch — capability + depth guard", () => {
  test("admits when the target lists the source as an allowed caller", () => {
    const verdict = canDispatch({
      source: "plan",
      target: "scout",
      action: "grep",
      allowedCallers: ["plan"],
      depth: 0,
    });
    expect(verdict.ok).toBe(true);
  });

  test("denies a caller the target does not admit with capability_denied", () => {
    const verdict = canDispatch({
      source: "triage",
      target: "implement",
      action: "session",
      allowedCallers: ["plan"], // implement admits plan, not triage
      depth: 0,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("capability_denied");
      expect(verdict.detail).toContain("triage");
      expect(verdict.detail).toContain("implement");
    }
  });

  test("denies depth >= MAX_DISPATCH_DEPTH with depth_exceeded", () => {
    const verdict = canDispatch({
      source: "plan",
      target: "scout",
      action: "grep",
      depth: MAX_DISPATCH_DEPTH,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("depth_exceeded");
    }
  });

  test("rejects empty action with verb_unknown", () => {
    const verdict = canDispatch({
      source: "plan",
      target: "scout",
      action: "",
      depth: 0,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("verb_unknown");
    }
  });

  test("rejects unknown source/target with actor_unknown", () => {
    const v1 = canDispatch({
      source: "ghost" as DispatchActor,
      target: "scout",
      action: "grep",
      depth: 0,
    });
    expect(v1.ok).toBe(false);
    if (!v1.ok) expect(v1.reason).toBe("actor_unknown");

    const v2 = canDispatch({
      source: "plan",
      target: "ghost" as DispatchActor,
      action: "grep",
      depth: 0,
    });
    expect(v2.ok).toBe(false);
    if (!v2.ok) expect(v2.reason).toBe("actor_unknown");
  });

  test("scout and gc declare no outbound dispatch (advisory map)", () => {
    // GH-1530 PR-6: `defaultDispatchCapabilities` is no longer a gate — it is
    // the advisory outbound declaration projected into the runtime-profile
    // contract. scout/gc declare no outbound targets.
    expect(defaultDispatchCapabilities.scout).toEqual([]);
    expect(defaultDispatchCapabilities.gc).toEqual([]);
  });

  test("self-dispatch (source === target) is always allowed", () => {
    for (const a of dispatchActors) {
      const verdict = canDispatch({
        source: a,
        target: a,
        action: "status",
        depth: 0,
      });
      expect(verdict.ok).toBe(true);
    }
  });

  test("self-dispatch still subject to depth check", () => {
    const verdict = canDispatch({
      source: "plan",
      target: "plan",
      action: "status",
      depth: MAX_DISPATCH_DEPTH,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("depth_exceeded");
    }
  });
});

// ── GH-1530 PR-6 target-authoritative object-capability gate ───────────────
// The target's inbound `allowedCallers` is the SOLE cross-actor authority: a
// dispatch is admitted iff the source appears in it. The former caller-side
// outbound gate (`allowedTargets`) was retired. An absent or empty list admits
// no caller (deny-by-default). Self-dispatch bypasses the gate.

describe("canDispatch — target-authoritative inbound gate (ocap)", () => {
  test("admits when the target's allowedCallers lists the source", () => {
    const verdict = canDispatch({
      source: "plan",
      target: "chain",
      action: "status",
      allowedCallers: ["plan"],
      depth: 0,
    });
    expect(verdict.ok).toBe(true);
  });

  test("target rejects a caller it does not admit", () => {
    const verdict = canDispatch({
      source: "triage",
      target: "chain",
      action: "status",
      allowedCallers: ["plan"], // chain admits only plan.
      depth: 0,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("capability_denied");
      expect(verdict.detail).toContain("does not admit caller");
    }
  });

  test("empty allowedCallers rejects every caller (non-dispatchable target)", () => {
    const verdict = canDispatch({
      source: "plan",
      target: "chain",
      action: "status",
      allowedCallers: [],
      depth: 0,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("capability_denied");
  });

  test("omitted allowedCallers denies cross-actor dispatch (deny-by-default)", () => {
    const verdict = canDispatch({
      source: "scout",
      target: "plan",
      action: "save",
      // allowedCallers omitted ⇒ treated as the empty set ⇒ deny.
      depth: 0,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("capability_denied");
  });

  test("self-dispatch bypasses the inbound gate (empty allowedCallers still allowed)", () => {
    const verdict = canDispatch({
      source: "plan",
      target: "plan",
      action: "status",
      allowedCallers: [],
      depth: 0,
    });
    expect(verdict.ok).toBe(true);
  });
});

// ── envelope schemas (Zod boundary) ────────────────────────────────────────

describe("dispatch envelope schemas", () => {
  test("dispatchRequestSchema validates well-formed request", () => {
    const parsed = dispatchRequestSchema.parse({
      source: "plan",
      target: "scout",
      action: "grep",
      args: { pattern: "mkdtemp" },
    });
    expect(parsed.source).toBe("plan");
    expect(parsed.args).toEqual({ pattern: "mkdtemp" });
  });

  test("dispatchRequestSchema defaults args to {}", () => {
    const parsed = dispatchRequestSchema.parse({
      source: "plan",
      target: "scout",
      action: "grep",
    });
    expect(parsed.args).toEqual({});
  });

  test("dispatchRequestSchema rejects unknown actor", () => {
    expect(() =>
      dispatchRequestSchema.parse({
        source: "ghost",
        target: "scout",
        action: "grep",
      }),
    ).toThrow();
  });

  test("dispatchResultSchema validates casHandle shape", () => {
    const parsed = dispatchResultSchema.parse({
      casHandle: `scout://${sampleSha}`,
      target: "scout",
      exitCode: 0,
      durationMs: 7,
    });
    expect(parsed.casHandle).toBe(`scout://${sampleSha}`);
  });

  test("dispatchResultSchema rejects malformed casHandle", () => {
    expect(() =>
      dispatchResultSchema.parse({
        casHandle: "not-a-uri",
        target: "scout",
        exitCode: 0,
        durationMs: 7,
      }),
    ).toThrow();
  });

  test("dispatchFailureSchema validates failure envelope", () => {
    const parsed = dispatchFailureSchema.parse({
      reason: "capability_denied",
      detail: "triage cannot dispatch to implement",
    });
    expect(parsed.reason).toBe("capability_denied");
  });
});

// ── readDispatchDepth ──────────────────────────────────────────────────────

describe("readDispatchDepth — env propagation", () => {
  test("returns 0 when env unset", () => {
    expect(readDispatchDepth({})).toBe(0);
  });

  test("parses positive integer", () => {
    expect(readDispatchDepth({ PRX_DISPATCH_DEPTH: "2" })).toBe(2);
  });

  test("treats non-numeric / negative as 0", () => {
    expect(readDispatchDepth({ PRX_DISPATCH_DEPTH: "" })).toBe(0);
    expect(readDispatchDepth({ PRX_DISPATCH_DEPTH: "abc" })).toBe(0);
    expect(readDispatchDepth({ PRX_DISPATCH_DEPTH: "-1" })).toBe(0);
  });
});

// ── dispatch machine — happy path ──────────────────────────────────────────

describe("dispatchMachine — success path", () => {
  test("validating → invoking → writingCas → done", async () => {
    const stdout = Buffer.from('{"path":"src/x.ts","line":12,"content":"mkdtemp"}\n');
    const machine = createDispatchMachine({
      invokeTargetVerb: okInvoke(stdout, 0, 12),
      writeCasBlob: okWriteCas(sampleSha, "dispatch:plan:1"),
    });

    const { value, context, output } = await runToCompletion(machine, baseRequest);

    expect(value).toBe("done");
    expect(context.failure).toBeNull();
    expect(context.invokeOutput?.exitCode).toBe(0);
    expect(context.writeOutput?.sha).toBe(sampleSha);
    expect(output).toBeDefined();
    expect(isDispatchSuccess(output as DispatchResult | DispatchFailure)).toBe(true);
    if (output && isDispatchSuccess(output)) {
      expect(output.casHandle).toBe(`scout://${sampleSha}`);
      expect(output.target).toBe("scout");
      expect(output.exitCode).toBe(0);
      expect(output.durationMs).toBe(12);
      const parsed = parseCasUri(output.casHandle);
      expect(parsed.domain).toBe("scout");
      expect(parsed.sha).toBe(sampleSha);
    }
  });
});

// ── dispatch machine — failure paths ───────────────────────────────────────

describe("dispatchMachine — capability deny", () => {
  test("non-whitelisted source/target → failed with capability_denied", async () => {
    const machine = createDispatchMachine({
      invokeTargetVerb: okInvoke(Buffer.from("never-runs")),
      writeCasBlob: okWriteCas(sampleSha, "never-set"),
    });

    const { value, output } = await runToCompletion(machine, {
      source: "triage",
      target: "implement",
      action: "session",
      args: {},
      depth: 0,
    });

    expect(value).toBe("failed");
    expect(output).toBeDefined();
    expect(isDispatchSuccess(output as DispatchResult | DispatchFailure)).toBe(false);
    if (output && !isDispatchSuccess(output)) {
      expect(output.reason).toBe("capability_denied");
    }
  });
});

describe("dispatchMachine — depth deny", () => {
  test("depth >= MAX → failed with depth_exceeded; invoke not called", async () => {
    let invokeCalls = 0;
    const sentinel = fromPromise<InvokeTargetVerbOutput, InvokeTargetVerbInput>(async () => {
      invokeCalls += 1;
      return { stdout: Buffer.alloc(0), exitCode: 0, durationMs: 0 };
    });
    const machine = createDispatchMachine({
      invokeTargetVerb: sentinel,
      writeCasBlob: okWriteCas(sampleSha, "n/a"),
    });

    const { value, output } = await runToCompletion(machine, {
      ...baseRequest,
      depth: MAX_DISPATCH_DEPTH,
    });

    expect(value).toBe("failed");
    expect(invokeCalls).toBe(0);
    if (output && !isDispatchSuccess(output)) {
      expect(output.reason).toBe("depth_exceeded");
    }
  });
});

describe("dispatchMachine — invoke failure", () => {
  test("target verb throws → failed with execution_failed", async () => {
    const machine = createDispatchMachine({
      invokeTargetVerb: failingInvoke("rg exited 2: regex parse error"),
      writeCasBlob: okWriteCas(sampleSha, "n/a"),
    });

    const { value, output } = await runToCompletion(machine, baseRequest);

    expect(value).toBe("failed");
    if (output && !isDispatchSuccess(output)) {
      expect(output.reason).toBe("execution_failed");
      expect(output.detail).toContain("rg exited 2");
    }
  });
});

describe("dispatchMachine — writeCas failure", () => {
  test("cas write throws → failed with execution_failed", async () => {
    const machine = createDispatchMachine({
      invokeTargetVerb: okInvoke(Buffer.from("body"), 0, 3),
      writeCasBlob: failingWriteCas("disk full"),
    });

    const { value, output } = await runToCompletion(machine, baseRequest);

    expect(value).toBe("failed");
    if (output && !isDispatchSuccess(output)) {
      expect(output.reason).toBe("execution_failed");
      expect(output.detail).toContain("disk full");
    }
  });
});

// ── GH-2418: OCAP gate wired live (capability = artifact possession) ───────
// The typed-input gate is no longer a library function the live machine
// ignores — it runs in `validating` alongside the role ACL. These cases prove
// claims 2 (capability = possession) and 3 (revocation = remove from closure)
// at the machine level: same source→target, the only thing that flips the
// verdict is whether the request carries a matching inputArtifact.

describe("dispatchMachine — OCAP typed-input gate (GH-2418)", () => {
  const okMachine = () =>
    createDispatchMachine({
      invokeTargetVerb: okInvoke(Buffer.from("scout-output"), 0, 4),
      writeCasBlob: okWriteCas(sampleSha, "dispatch:implement:1"),
    });

  // scout admits implement (target-authoritative role ACL passes), so the role
  // ACL alone would allow it; the OCAP gate is what denies the untyped call.
  const implementToScout = {
    source: "implement",
    target: "scout",
    action: "grep",
    args: {},
    depth: 0,
    allowedCallers: ["implement"],
    expectedInputType: "query",
  } satisfies Partial<DispatchMachineInput> as DispatchMachineInput;

  test("gate off (rejectUntyped=false): untyped dispatch proceeds (backwards-compatible)", async () => {
    const { value, output } = await runToCompletion(okMachine(), {
      ...implementToScout,
      rejectUntyped: false,
    });
    expect(value).toBe("done");
    expect(isDispatchSuccess(output as DispatchResult | DispatchFailure)).toBe(true);
  });

  test("revoked (gate on, no inputArtifact in closure): failed/capability_denied; invoke never runs", async () => {
    let invokeCalls = 0;
    const sentinel = fromPromise<InvokeTargetVerbOutput, InvokeTargetVerbInput>(async () => {
      invokeCalls += 1;
      return { stdout: Buffer.alloc(0), exitCode: 0, durationMs: 0 };
    });
    const machine = createDispatchMachine({
      invokeTargetVerb: sentinel,
      writeCasBlob: okWriteCas(sampleSha, "n/a"),
    });
    const { value, output } = await runToCompletion(machine, {
      ...implementToScout,
      rejectUntyped: true,
    });
    expect(value).toBe("failed");
    expect(invokeCalls).toBe(0);
    if (output && !isDispatchSuccess(output)) {
      expect(output.reason).toBe("capability_denied");
      expect(output.detail).toContain("query");
    }
  });

  test("granted (gate on, matching inputArtifact in closure): proceeds to done", async () => {
    const { value, output } = await runToCompletion(okMachine(), {
      ...implementToScout,
      rejectUntyped: true,
      inputArtifact: { type: "query" },
    });
    expect(value).toBe("done");
    expect(isDispatchSuccess(output as DispatchResult | DispatchFailure)).toBe(true);
  });

  test("wrong artifact in closure (gate on, type mismatch): capability_denied", async () => {
    const { value, output } = await runToCompletion(okMachine(), {
      ...implementToScout,
      rejectUntyped: true,
      inputArtifact: { type: "plan" },
    });
    expect(value).toBe("failed");
    if (output && !isDispatchSuccess(output)) {
      expect(output.reason).toBe("capability_denied");
      expect(output.detail).toContain("query");
    }
  });

  test("role ACL still primary backstop: gate on but ACL-denied target → capability_denied, OCAP not reached", async () => {
    // triage → implement is not on the role ACL; the coarse gate denies first.
    const { value, output } = await runToCompletion(okMachine(), {
      source: "triage",
      target: "implement",
      action: "session",
      args: {},
      depth: 0,
      rejectUntyped: true,
      expectedInputType: "plan",
    });
    expect(value).toBe("failed");
    if (output && !isDispatchSuccess(output)) {
      expect(output.reason).toBe("capability_denied");
      expect(output.detail).toContain("triage");
    }
  });
});

// ── GH-2418 claim 1: every gate-eligible target resolves a typed input ─────

describe("structured I/O per agent (GH-2418 claim 1)", () => {
  // GH-1530 widened `dispatchActors` from the hand-listed dispatch set to full
  // `ActorName` parity (most actors are terminal and bear no AgentContract), so
  // the typed-input claim now scopes to the contract-bearing dispatch
  // participants — the agent-role / session-profile actors that are valid
  // typed-dispatch targets. These are exactly the actors `getAgentContract`
  // resolves (`taskAgentRoles ∪ sessionProfileNames`).
  const CONTRACT_BEARING_DISPATCH = [
    "plan",
    "triage",
    "intake",
    "implement",
    "submit",
    "author",
    "scout",
    "gc",
    "scratch",
  ] as const satisfies readonly (typeof dispatchActors)[number][];

  test("every contract-bearing dispatch actor resolves an AgentContract.inputArtifact", () => {
    for (const a of CONTRACT_BEARING_DISPATCH) {
      const contract = getAgentContract(a);
      expect(contract, `dispatch participant '${a}' must resolve a contract`).toBeDefined();
      expect(typeof contract!.inputArtifact).toBe("string");
      expect(contract!.inputArtifact.length).toBeGreaterThan(0);
    }
  });
});

// ── runtime profile cross-check ────────────────────────────────────────────

describe("dispatch capability — runtime profile mirror", () => {
  test("SESSION_PROFILES.allowedDispatchTargets matches default policy", async () => {
    const { SESSION_PROFILES } = await import("../../src/machine/runtime_profiles.ts");
    for (const profile of ["plan", "intake", "triage", "implement"] as const) {
      expect(SESSION_PROFILES[profile].allowedDispatchTargets).toEqual([
        ...defaultDispatchCapabilities[profile],
      ]);
    }
  });

  test("dispatch event vocabulary exposed on prx in eventOwnerMap", async () => {
    const { eventOwnerMap, toolActorCatalog } = await import("../../src/machine/actors.ts");
    expect(eventOwnerMap.DISPATCH_REQUESTED).toBe("prx");
    expect(eventOwnerMap.DISPATCH_COMPLETED).toBe("prx");
    expect(eventOwnerMap.DISPATCH_FAILED).toBe("prx");
    expect(toolActorCatalog.prx.accepts).toContain("dispatch");
  });
});

describe("dispatch actor taxonomy", () => {
  test("dispatchActors is at ActorName parity (GH-1530) and still covers the legacy dispatch set", async () => {
    // GH-1530 unified `dispatchActors` with the CLI registry's `ActorName`
    // enum via the shared `actor_names.ts` leaf — both now enumerate the same
    // canonical vocabulary, so cross-actor dispatch is no longer gated by a
    // hand-listed source subset. The capability policy (who may reach whom)
    // is target-authoritative (each target's `allowedCallers`), not the
    // membership set.
    const { actorNames } = await import("../../src/machine/actor_names.ts");
    expect([...dispatchActors].sort()).toEqual([...actorNames].sort());
    // The former hand-listed dispatch actors stay members (no regression);
    // GH-2394's `scratch` is included.
    for (const legacy of [
      "plan",
      "triage",
      "intake",
      "implement",
      "submit",
      "author",
      "scout",
      "gc",
      "scratch",
    ] as const) {
      expect(dispatchActors as readonly string[]).toContain(legacy);
    }
  });

  test("casUriFor produces parseable handles for every dispatch actor", () => {
    for (const a of dispatchActors) {
      const uri = casUriFor(a, sampleSha);
      const parsed = parseCasUri(uri);
      expect(parsed.domain).toBe(a);
      expect(parsed.sha).toBe(sampleSha);
    }
  });
});
