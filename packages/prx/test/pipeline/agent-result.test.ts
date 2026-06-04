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
  renderPlanAgentResult,
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
    ).toBe("prx intake agent: no action — not actionable");
  });

  test("renderAgentResult surfaces the triage dispositions (prx-9p9)", () => {
    const base = { actor: "triage", status: 0, uows: [] as string[], summary: "" };
    expect(
      renderAgentResult({ ...base, disposition: "classified", uow: "prx-0v5" }),
    ).toBe("prx triage agent: classified prx-0v5");
    expect(
      renderAgentResult({ ...base, disposition: "promoted", uow: "prx-0v5", reason: "ready" }),
    ).toBe("prx triage agent: promoted prx-0v5 — ready");
    expect(
      renderAgentResult({ ...base, disposition: "deferred", uow: "prx-0v5", reason: "blocked" }),
    ).toBe("prx triage agent: deferred prx-0v5 — blocked");
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

  test("renderPlanAgentResult frames input artifact → output artifact (prx-j4a)", () => {
    // Validated draft: one clean input→output line + validated flag, no viewer.
    expect(
      renderPlanAgentResult({
        actor: "plan",
        unit: "prx-0v5",
        source: "beads",
        ref: "prx-0v5:plan@draft",
        validated: true,
        diagnostics: 0,
      }),
    ).toBe("plan: prx-0v5 (beads) → prx-0v5:plan@draft\n  validated=true");

    // Shape-failing draft: diagnostics count + the viewer command to resolve it.
    expect(
      renderPlanAgentResult({
        actor: "plan",
        unit: "prx-0v5",
        source: "beads",
        ref: "prx-0v5:plan@draft",
        validated: false,
        diagnostics: 1,
        view: "prx plan show prx-0v5 --slot draft",
      }),
    ).toBe(
      "plan: prx-0v5 (beads) → prx-0v5:plan@draft\n  validated=false (1 diagnostic)\n  view: prx plan show prx-0v5 --slot draft",
    );

    // No source → the `(source)` annotation is omitted.
    expect(
      renderPlanAgentResult({ actor: "plan", unit: "GH-7", ref: "GH-7:plan@draft", validated: true, diagnostics: 0 }),
    ).toBe("plan: GH-7 → GH-7:plan@draft\n  validated=true");
  });

  test("captureAgentResult flags a contract violation and does NOT pin (prx-bs4)", async () => {
    // The agent reported `filed` but named no UoW — the agent_result edge's
    // validator catches it; the result is surfaced (diagnostics) and not pinned.
    const set = new Set<string>();
    const { ref, result, diagnostics } = await captureAgentResult({
      actor: "intake",
      workspaceId: "deadbeef0003",
      status: 0,
      stdout: "",
      before: set,
      after: set,
      reported: { disposition: "filed" },
    });
    expect(diagnostics.map((d) => d.code)).toContain("missing-uow");
    expect(ref).toBe(""); // invalid → not pinned
    expect(result.disposition).toBe("filed");
  });

  test("captureAgentResult pins (no diagnostics) when the disposition is consistent", async () => {
    const set = new Set<string>();
    const { ref, diagnostics } = await captureAgentResult({
      actor: "intake",
      workspaceId: "deadbeef0004",
      status: 0,
      stdout: "",
      before: set,
      after: set,
      reported: { disposition: "filed", uow: "prx-ccc" },
    });
    expect(diagnostics).toEqual([]);
    expect(ref).toBe("deadbeef0004:agent_result@latest");
  });
});
