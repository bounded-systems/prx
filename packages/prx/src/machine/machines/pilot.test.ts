import { describe, expect, test } from "bun:test";
import { createActor, waitFor } from "xstate";

import {
  createPilotMachine,
  pilotMeasure,
  roleProfile,
  stubLegRunner,
  type CiGate,
  type LegRunner,
} from "./pilot.ts";
import type { TaskRole } from "./task.ts";

/** Lexicographic strict-less over the ℕ² measure tuples. */
function lexLess(a: [number, number], b: [number, number]): boolean {
  return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
}

describe("pilot (Layer-1: self-driving, CI-gated, signed in-toto)", () => {
  test("drives planning → … → merged and accumulates the full signed chain", async () => {
    const visited: TaskRole[] = [];
    const trace: LegRunner = (input) => {
      visited.push(input.role);
      return stubLegRunner(input);
    };

    const actor = createActor(createPilotMachine(trace), {
      input: { workUnitId: "prx-demo" },
    }).start();
    const done = await waitFor(actor, (s) => s.status === "done", { timeout: 2000 });

    expect(done.value).toBe("merged");
    // The four role legs ran in order (gate + merge are not legs).
    expect(visited).toEqual(["planner", "executor", "tester", "reviewer"]);

    // Chain = 4 leg links + CI gate + merge, each signed by its actor.
    expect(done.context.chain.map((l) => l.subject)).toEqual([
      "prx-demo:plan@draft",
      "prx-demo:implement@latest",
      "prx-demo:gate@ci",
      "prx-demo:submit@ready",
      "prx-demo:gate@ci-remote",
      "prx-demo:merged@pr",
    ]);
    expect(done.context.chain.map((l) => l.signedBy)).toEqual([
      "planner@stub",
      "executor@stub",
      "tester@stub",
      "reviewer@stub",
      "remote_ci@stub",
      "publisher@stub",
    ]);

    // The pilot minted its own in-toto summary over the whole chain.
    const summary = done.context.summary!;
    expect(summary._type).toBe("https://in-toto.io/Statement/v1");
    expect(summary.predicateType).toBe("prx.pilot/v1");
    expect((summary.predicate as { legCount: number }).legCount).toBe(6);
    expect(summary.subject[0]!.name).toBe("prx-demo");
    // Machine output carries the chain + summary up to the fleet.
    expect(done.output!.summary).toBe(summary);
  });

  test("HARD BLOCK: a red CI gate never reaches merged — it abandons", async () => {
    const redGate: CiGate = ({ workUnitId }) =>
      Promise.resolve({
        passed: false,
        attestation: {
          stage: "ci",
          subject: `${workUnitId}:gate@ci-remote`,
          predicate: "ci.failed",
          signedBy: "remote_ci@stub",
          sig: "x",
        },
      });

    const actor = createActor(
      createPilotMachine({ runLeg: stubLegRunner, runCiGate: redGate }),
      { input: { workUnitId: "prx-redci", retreatBudget: 2 } },
    ).start();
    const halted = await waitFor(actor, (s) => s.status === "done", { timeout: 2000 });

    expect(halted.value).toBe("abandoned");
    // No merge link was ever produced — the gate is structural, not advisory.
    expect(halted.context.chain.some((l) => l.stage === "merge")).toBe(false);
    expect(halted.context.chain.some((l) => l.predicate === "ci.failed")).toBe(true);
    expect(halted.context.summary).toBeUndefined();
  });

  test("a non-advancing leg parks in blocked but still signs its link", async () => {
    const stopAtExecutor: LegRunner = (input) =>
      stubLegRunner(input).then((r) => ({ ...r, advance: input.role !== "executor" }));

    const actor = createActor(createPilotMachine(stopAtExecutor), {
      input: { workUnitId: "prx-block" },
    }).start();
    const blocked = await waitFor(actor, (s) => s.value === "blocked", { timeout: 2000 });

    expect(blocked.context.chain.map((l) => l.stage)).toEqual(["planner", "executor"]);
  });

  test("PROVEN termination: a permanently-failing leg is abandoned, never loops", async () => {
    const alwaysFailsExecutor: LegRunner = (input) =>
      input.role === "executor"
        ? Promise.reject(new Error("permanently denied"))
        : stubLegRunner(input);

    const actor = createActor(createPilotMachine(alwaysFailsExecutor), {
      input: { workUnitId: "prx-doomed", retreatBudget: 3 },
    }).start();
    const halted = await waitFor(actor, (s) => s.status === "done", { timeout: 2000 });

    expect(halted.value).toBe("abandoned");
    expect(halted.context.retreatBudget).toBe(0);
    expect(halted.context.lastError).toContain("permanently denied");
  });

  test("the well-founded measure strictly decreases on every transition", async () => {
    const measures: Array<[number, number] | null> = [];
    const flakyOnce: LegRunner = (() => {
      let firstExec = true;
      return (input: Parameters<LegRunner>[0]) => {
        if (input.role === "executor" && firstExec) {
          firstExec = false;
          return Promise.reject(new Error("transient"));
        }
        return stubLegRunner(input);
      };
    })();

    const actor = createActor(createPilotMachine(flakyOnce), {
      input: { workUnitId: "prx-measure", retreatBudget: 3 },
    });
    actor.subscribe((s) => measures.push(pilotMeasure(String(s.value), s.context)));
    actor.start();
    await waitFor(actor, (s) => s.status === "done", { timeout: 2000 });

    const active = measures.filter((m): m is [number, number] => m !== null);
    for (let i = 1; i < active.length; i++) {
      expect(lexLess(active[i]!, active[i - 1]!)).toBe(true);
    }
    expect(active.length).toBeGreaterThan(4);
  });

  test("roleProfile binds each role to a scoped subagent + signed artifact", () => {
    expect(roleProfile.planner.tools).not.toContain("Write");
    expect(roleProfile.executor.tools).toContain("Write");
    for (const role of Object.keys(roleProfile) as TaskRole[]) {
      expect(roleProfile[role].agent).toBe(role);
      expect(roleProfile[role].signs.length).toBeGreaterThan(0);
    }
  });
});
