import { describe, expect, test } from "bun:test";
import { createActor, waitFor } from "xstate";

import type { NonInteractiveAgentResult } from "../../claude/agent_service.ts";
import { createPilotMachine, type LegInput } from "./pilot.ts";
import { createSdkLegRunner, type RoleSigner, type RunRoleAgent } from "./pilot-runner.ts";

const ok = (text: string): NonInteractiveAgentResult => ({
  kind: "success",
  text,
  stdout: text,
  usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  elapsed_ms: 1,
});

// A signer that records what it signed and returns a deterministic signature.
const recordingSigner = (signed: Array<{ role: string; outputHash: string }>): RoleSigner =>
  async ({ role, subject, outputHash }) => {
    signed.push({ role, outputHash });
    return { signedBy: `${role}@key`, sig: `sig(${subject}#${outputHash.slice(0, 8)})` };
  };

describe("sdk leg runner (machine ↔ real-agent + signing seam)", () => {
  test("drives the pilot over per-role agent runs and signs each leg", async () => {
    const ran: LegInput["role"][] = [];
    const runAgent: RunRoleAgent = async (input) => {
      ran.push(input.role);
      return ok(`${input.role} did work on ${input.workUnitId}`);
    };
    const signed: Array<{ role: string; outputHash: string }> = [];
    const runner = createSdkLegRunner({ runAgent, sign: recordingSigner(signed) });

    const actor = createActor(createPilotMachine(runner), {
      input: { workUnitId: "prx-real" },
    }).start();
    const done = await waitFor(actor, (s) => s.status === "done", { timeout: 2000 });

    expect(ran).toEqual(["planner", "executor", "tester", "reviewer"]);
    // The runner governs the four role legs; the CI gate + merge use defaults.
    expect(signed.map((s) => s.role)).toEqual(["planner", "executor", "tester", "reviewer"]);
    // GH-232: chain[0] is the intake `source@pinned` link. The role legs follow,
    // with the deterministic local-checks gate (default stub) at index 3 between
    // executor and tester.
    expect(done.context.chain.slice(1, 6).map((l) => l.signedBy)).toEqual([
      "planner@key",
      "executor@key",
      "local_checks@stub",
      "tester@key",
      "reviewer@key",
    ]);
    // The signature commits to the per-role artifact subject.
    const execLink = done.context.chain[2]!;
    expect(execLink.subject).toBe("prx-real:implement@latest");
    expect(execLink.predicate).toBe("executor.completed");
    expect(execLink.stage).toBe("executor");
  });

  test("a failed agent run throws → pilot retreats (executor → planning)", async () => {
    let execAttempts = 0;
    const runAgent: RunRoleAgent = async (input) => {
      if (input.role === "executor" && ++execAttempts === 1) {
        return { kind: "failed", errorKind: "model", message: "tool denied", elapsed_ms: 1 };
      }
      return ok(`${input.role} ok`);
    };
    const runner = createSdkLegRunner({ runAgent, sign: recordingSigner([]) });

    const actor = createActor(createPilotMachine(runner), {
      input: { workUnitId: "prx-fail" },
    }).start();
    const done = await waitFor(actor, (s) => s.status === "done", { timeout: 2000 });

    expect(execAttempts).toBeGreaterThanOrEqual(2);
    expect(done.context.lastError).toContain("agent failed");
  });

  test("a planner rejection (decision:blocked) halts the pilot before the executor (GH-289)", async () => {
    const ran: LegInput["role"][] = [];
    const runAgent: RunRoleAgent = async (input) => {
      ran.push(input.role);
      if (input.role === "planner") {
        // A submitted-but-blocked plan: the agent run succeeded, but the planner
        // declared the work cannot proceed. The pilot must NOT advance.
        return { ...ok("blocked: the requested change is out of scope"), planDecision: "blocked" };
      }
      return ok(`${input.role} ok`);
    };
    const runner = createSdkLegRunner({ runAgent, sign: recordingSigner([]) });

    const actor = createActor(createPilotMachine(runner), {
      input: { workUnitId: "prx-reject" },
    }).start();
    const blocked = await waitFor(actor, (s) => s.value === "blocked", { timeout: 2000 });

    expect(blocked.value).toBe("blocked");
    // The cascade is stopped: no executor/tester/reviewer leg ran.
    expect(ran).toEqual(["planner"]);
    const last = blocked.context.chain.at(-1)!;
    expect(last.stage).toBe("planner");
    expect(last.predicate).toBe("planner.rejected");
  });

  test("a cancelled run parks in blocked and signs the stop", async () => {
    const runAgent: RunRoleAgent = async (input) => {
      if (input.role === "executor") {
        return {
          kind: "cancelled",
          reason: "watchdog",
          elapsed_ms: 1,
          configured_timeout_ms: 1000,
          draftRef: null,
          partialStdout: "half-done",
        };
      }
      return ok(`${input.role} ok`);
    };
    const runner = createSdkLegRunner({ runAgent, sign: recordingSigner([]) });

    const actor = createActor(createPilotMachine(runner), {
      input: { workUnitId: "prx-cancel" },
    }).start();
    const blocked = await waitFor(actor, (s) => s.value === "blocked", { timeout: 2000 });

    expect(blocked.value).toBe("blocked");
    const last = blocked.context.chain.at(-1)!;
    expect(last.stage).toBe("executor");
    expect(last.predicate).toBe("executor.blocked"); // the stop is on the record
  });
});
