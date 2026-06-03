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

  test("renderAgentResult surfaces the reported disposition (existing issue / reason)", () => {
    const base = { actor: "intake", status: 0, uows: [] as string[], summary: "" };
    expect(
      renderAgentResult({ ...base, disposition: "filed", uow: "bd-ccc" }),
    ).toBe("prx intake agent: filed bd-ccc");
    expect(
      renderAgentResult({ ...base, disposition: "merged", uow: "bd-yyy", reason: "dup" }),
    ).toBe("prx intake agent: merged into bd-yyy — dup");
    expect(
      renderAgentResult({ ...base, disposition: "duplicate", uow: "bd-yyy" }),
    ).toBe("prx intake agent: already tracked by bd-yyy");
    expect(
      renderAgentResult({ ...base, disposition: "no_action", reason: "not actionable" }),
    ).toBe("prx intake agent: no issue filed — not actionable");
  });

  test("renderAgentResult falls back to the bead diff when nothing was reported", () => {
    const base = { actor: "intake", status: 0, summary: "" };
    expect(renderAgentResult({ ...base, uows: ["bd-z"] })).toBe(
      "prx intake agent: created bd-z",
    );
    expect(renderAgentResult({ ...base, uows: [] })).toBe(
      "prx intake agent: no result reported",
    );
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

  test("captureAgentResult carries the reported disposition into the result", async () => {
    const set = new Set<string>();
    const { result } = await captureAgentResult({
      actor: "intake",
      workspaceId: "deadbeef0002",
      status: 0,
      stdout: "",
      before: set,
      after: set,
      reported: { disposition: "merged", uow: "bd-yyy", reason: "dup of bd-yyy" },
    });
    expect(result.disposition).toBe("merged");
    expect(result.uow).toBe("bd-yyy");
    expect(renderAgentResult(result)).toBe(
      "prx intake agent: merged into bd-yyy — dup of bd-yyy",
    );
  });
});
