/**
 * prx-lfv — the agent-result return channel: a headless `prx <actor> agent` run
 * pins its outcome to the CAS and surfaces the UoW (the bead it created), so it
 * is never a silent success. UoW detection is a bead-id diff (after − before).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  captureAgentResult,
  renderAgentResult,
  snapshotBeadIds,
  summarizeAgentStdout,
} from "../../src/pipeline/agent-result.ts";

let prevRoot: string | undefined;
beforeAll(() => {
  prevRoot = process.env.PRX_CAS_ROOT;
  process.env.PRX_CAS_ROOT = mkdtempSync(join(tmpdir(), "prx-agent-result-"));
});
afterAll(() => {
  if (prevRoot === undefined) delete process.env.PRX_CAS_ROOT;
  else process.env.PRX_CAS_ROOT = prevRoot;
});

describe("agent-result return channel (prx-lfv)", () => {
  test("captureAgentResult pins to CAS + reports the new UoW (bead diff)", async () => {
    const before = new Set(["prx-aaa", "prx-bbb"]);
    const after = new Set(["prx-aaa", "prx-bbb", "prx-ccc"]); // prx-ccc is new
    const { ref, result } = await captureAgentResult({
      actor: "intake",
      workspaceId: "deadbeef0000",
      status: 0,
      stdout: JSON.stringify({ type: "result", result: "Filed prx-ccc." }),
      before,
      after,
    });
    expect(ref).toBe("deadbeef0000:agent_result@latest");
    expect(result.uows).toEqual(["prx-ccc"]);
    expect(result.summary).toBe("Filed prx-ccc.");
  });

  test("no new beads → empty UoW list (honest 'no UoW')", async () => {
    const set = new Set(["prx-aaa"]);
    const { result } = await captureAgentResult({
      actor: "intake",
      workspaceId: "deadbeef0001",
      status: 0,
      stdout: "",
      before: set,
      after: set,
    });
    expect(result.uows).toEqual([]);
  });

  test("renderAgentResult is never silent — UoW or 'no new UoW'", () => {
    expect(
      renderAgentResult("r@latest", {
        actor: "intake",
        status: 0,
        uows: ["prx-ccc"],
        summary: "x",
      }),
    ).toContain("UoW: prx-ccc");
    expect(
      renderAgentResult("r@latest", {
        actor: "intake",
        status: 0,
        uows: [],
        summary: "x",
      }),
    ).toContain("no new UoW");
  });

  test("summarizeAgentStdout extracts the SDK envelope result text", () => {
    expect(summarizeAgentStdout(JSON.stringify({ type: "result", result: "hi" }))).toBe("hi");
    expect(summarizeAgentStdout("raw text")).toBe("raw text");
  });

  test("snapshotBeadIds uses the injected reader", () => {
    expect(snapshotBeadIds("/repo", () => ["prx-x", "prx-y"])).toEqual(
      new Set(["prx-x", "prx-y"]),
    );
  });

  test("snapshotBeadIds degrades to empty when the reader throws (bd absent / CI)", () => {
    expect(
      snapshotBeadIds("/repo", () => {
        throw new Error("spawn bd ENOENT");
      }),
    ).toEqual(new Set());
  });

  test("renderAgentResult omits the ref when the CAS pin failed (empty ref)", () => {
    expect(
      renderAgentResult("", {
        actor: "intake",
        status: 0,
        uows: ["prx-z"],
        summary: "",
      }),
    ).toBe("prx intake agent → UoW: prx-z");
  });
});
