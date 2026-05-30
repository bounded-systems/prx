// GH-2016 — map machine smoke. Two routes (create/show) and a stub route
// (sync) covered against real actors over a tmp .prx/ root.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActor } from "xstate";

import { mapMachine, type MapMachineInput } from "../../src/map/machine.ts";

function mkRepoRoot(): string {
  return mkdtempSync(join(tmpdir(), "prx-map-machine-"));
}

async function runToDone(input: MapMachineInput): Promise<ReturnType<typeof createActor<typeof mapMachine>>> {
  const actor = createActor(mapMachine, { input });
  actor.start();
  await new Promise<void>((resolve) => {
    const sub = actor.subscribe((state) => {
      if (state.status === "done") {
        sub.unsubscribe();
        resolve();
      }
    });
  });
  return actor;
}

describe("mapMachine", () => {
  test("create route writes the record and reaches `completed`", async () => {
    const repoRoot = mkRepoRoot();
    const actor = await runToDone({
      verb: "create",
      options: {
        kind: "inline",
        name: "delegate-unblock",
        tickets: ["GH-2011", "GH-2012"],
        rationale: "GH-2011 gates GH-2012.",
        created: "2026-05-18",
        parents: [],
        repoRoot,
      },
    });

    const snap = actor.getSnapshot();
    expect(snap.value).toBe("completed");
    expect(snap.context.createResult?.name).toBe("delegate-unblock");
    expect(snap.context.blockedReason).toBeNull();
  });

  test("show route renders the previously-created record", async () => {
    const repoRoot = mkRepoRoot();
    await runToDone({
      verb: "create",
      options: {
        kind: "inline",
        name: "delegate-unblock",
        tickets: ["GH-2011"],
        rationale: "test",
        created: "2026-05-18",
        parents: [],
        repoRoot,
      },
    });
    const actor = await runToDone({
      verb: "show",
      options: { name: "delegate-unblock", repoRoot, format: "plain" },
    });

    const snap = actor.getSnapshot();
    expect(snap.value).toBe("completed");
    expect(snap.context.showResult?.record.name).toBe("delegate-unblock");
    expect(snap.context.showResult?.rendered).toContain("map: delegate-unblock");
  });

  test("sync stub lands in `failed` with the GH-2016 ticket recorded", async () => {
    const repoRoot = mkRepoRoot();
    const actor = await runToDone({
      verb: "sync",
      options: { name: "delegate-unblock", repoRoot, dryRun: false },
    });

    const snap = actor.getSnapshot();
    expect(snap.value).toBe("failed");
    expect(snap.context.blockedReason?.actor).toBe("sync");
    expect(snap.context.blockedReason?.ticket).toBe("GH-2016");
    expect(snap.context.blockedReason?.message).toContain("not implemented");
  });
});
