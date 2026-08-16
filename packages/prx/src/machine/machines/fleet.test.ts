import { describe, expect, test } from "bun:test";
import { createActor, waitFor, type AnyStateMachine } from "xstate";

import { createFleetMachine, type FleetContext } from "./fleet.ts";
import { createPilotMachine, stubLegRunner } from "./pilot.ts";

const makeStubPilot = (_unitId: string): AnyStateMachine =>
  createPilotMachine(stubLegRunner) as AnyStateMachine;

describe("fleet (Layer-2: supervisor, agents view, batch in-toto)", () => {
  test("drives many pilots to merged, projects the board, mints a batch statement", async () => {
    const units = ["prx-a", "prx-b", "prx-c", "prx-d", "prx-e"];
    const fleet = createActor(createFleetMachine(makeStubPilot), {
      input: { units, wip: 2 },
    }).start();

    const drained = await waitFor(fleet, (s) => s.status === "done", { timeout: 4000 });
    expect(drained.value).toBe("drained");

    const board = drained.context.board;
    expect(Object.keys(board).sort()).toEqual([...units].sort());
    for (const unitId of units) {
      expect(board[unitId]!.status).toBe("halted");
      expect(board[unitId]!.state).toBe("merged");
      expect(board[unitId]!.chainLength).toBe(8); // intake + 4 legs + local checks + remote ci + merge
    }

    // The fleet signed a batch statement naming every pilot summary.
    const batch = drained.output!.batch!;
    expect(batch.predicateType).toBe("prx.fleet/v1");
    expect((batch.predicate as { unitCount: number }).unitCount).toBe(units.length);
    expect(batch.subject.map((s) => s.name).sort()).toEqual([...units].sort());
    expect(batch.signedBy).toBe("fleet@stub");
  });

  test("respects the WIP cap (never more than `wip` running at once)", async () => {
    const units = ["u1", "u2", "u3", "u4", "u5", "u6"];
    const fleet = createActor(createFleetMachine(makeStubPilot), {
      input: { units, wip: 2 },
    });

    let maxRunning = 0;
    fleet.subscribe((s) => {
      const ctx = s.context as FleetContext;
      const running = Object.values(ctx.board).filter((e) => e.status === "running").length;
      maxRunning = Math.max(maxRunning, running);
    });
    fleet.start();

    await waitFor(fleet, (s) => s.status === "done", { timeout: 4000 });
    expect(maxRunning).toBeLessThanOrEqual(2);
  });

  test("an empty unit list drains immediately with an empty batch", async () => {
    const fleet = createActor(createFleetMachine(makeStubPilot), {
      input: { units: [] },
    }).start();
    const drained = await waitFor(fleet, (s) => s.status === "done", { timeout: 2000 });
    expect(drained.value).toBe("drained");
    expect(Object.keys(drained.context.board)).toHaveLength(0);
    expect((drained.output!.batch!.predicate as { unitCount: number }).unitCount).toBe(0);
  });
});
