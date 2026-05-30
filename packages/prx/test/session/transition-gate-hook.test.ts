import { describe, expect, test } from "bun:test";

import {
  buildTransitionGateStopSettings,
  parseStopEnvelope,
  runTransitionGateHook,
  DEFAULT_TRANSITION_SLOT,
  type TransitionHookEnv,
} from "../../src/session/transition-gate-hook.ts";
import type { PinTransitionDeps } from "../../src/session/transition-artifact.ts";

function stubPinDeps(): PinTransitionDeps {
  return {
    writeBlob: async () => ({ sha: `sha256:${"c".repeat(64)}` }),
    setRef: async () => {},
    casUriFor: (domain, sha) => `${domain}://${sha}`,
  };
}

function run(env: TransitionHookEnv, slot: string | null, stdin = "{}") {
  return runTransitionGateHook({
    stdin,
    env,
    readSlot: () => slot,
    pinDeps: stubPinDeps(),
  });
}

describe("runTransitionGateHook (ai-home-wlw5l)", () => {
  test("a valid slot allows stop (exit 0) and returns the pinned handle", async () => {
    const r = await run({ PRX_AGENT_ROLE: "executor", PRX_WORK_UNIT: "GH-7" }, '{"status":"ok"}');
    expect(r.exitCode).toBe(0);
    expect(r.message).toBe(`executor://sha256:${"c".repeat(64)}`);
  });

  test("a missing slot (readSlot → null) blocks stop (exit 2) with a reason", async () => {
    const r = await run({ PRX_AGENT_ROLE: "executor", PRX_WORK_UNIT: "GH-7" }, null);
    expect(r.exitCode).toBe(2);
    expect(r.message).toContain("no transition artifact emitted");
  });

  test("an invalid (non-object) slot blocks stop (exit 2)", async () => {
    const r = await run({ PRX_AGENT_ROLE: "executor" }, "42");
    expect(r.exitCode).toBe(2);
    expect(r.message).toContain("schema_invalid");
  });

  test("planner role enforces the strict PlanArtifactSchema (a non-plan object blocks)", async () => {
    const r = await run({ PRX_AGENT_ROLE: "planner", PRX_PLAN_SESSION_UNIT: "GH-9" }, '{"nope":1}');
    expect(r.exitCode).toBe(2);
    expect(r.message).toContain("schema_invalid");
  });

  test("work unit resolves from PRX_PLAN_SESSION_UNIT / PRX_SUBMIT_SESSION_UNIT / PRX_WORK_UNIT", async () => {
    const r = await run({ PRX_AGENT_ROLE: "submit", PRX_SUBMIT_SESSION_UNIT: "GH-22" }, null);
    expect(r.exitCode).toBe(2);
    expect(r.message).toContain("submit/GH-22");
  });

  test("resolves the slot relative to the cwd in the mocked Stop envelope", async () => {
    const seen: string[] = [];
    await runTransitionGateHook({
      // Mock the Claude Code Stop-hook stdin envelope — the boundary contract.
      stdin: JSON.stringify({
        hook_event_name: "Stop",
        session_id: "sess-1",
        cwd: "/work/GH-5/wt",
        stop_hook_active: false,
      }),
      env: { PRX_AGENT_ROLE: "executor", PRX_WORK_UNIT: "GH-5" },
      readSlot: (path) => {
        seen.push(path);
        return null;
      },
      pinDeps: stubPinDeps(),
    });
    expect(seen).toEqual([`/work/GH-5/wt/${DEFAULT_TRANSITION_SLOT}`]);
  });

  test("PRX_TRANSITION_SLOT overrides the envelope-derived slot path", async () => {
    const seen: string[] = [];
    await runTransitionGateHook({
      stdin: JSON.stringify({ cwd: "/work/GH-5/wt" }),
      env: { PRX_AGENT_ROLE: "executor", PRX_TRANSITION_SLOT: "/explicit/slot.json" },
      readSlot: (path) => {
        seen.push(path);
        return null;
      },
      pinDeps: stubPinDeps(),
    });
    expect(seen).toEqual(["/explicit/slot.json"]);
  });

  test("a malformed/empty envelope is tolerated (slot falls back to relative cwd)", async () => {
    const seen: string[] = [];
    await runTransitionGateHook({
      stdin: "not json",
      env: { PRX_AGENT_ROLE: "executor" },
      readSlot: (path) => {
        seen.push(path);
        return null;
      },
      pinDeps: stubPinDeps(),
    });
    expect(seen).toEqual([DEFAULT_TRANSITION_SLOT]);
  });
});

describe("parseStopEnvelope (ai-home-wlw5l)", () => {
  test("parses a well-formed Stop envelope", () => {
    const e = parseStopEnvelope(
      JSON.stringify({ hook_event_name: "Stop", cwd: "/x", stop_hook_active: true }),
    );
    expect(e.cwd).toBe("/x");
    expect(e.stop_hook_active).toBe(true);
  });

  test("returns {} for empty / malformed / non-object input", () => {
    expect(parseStopEnvelope("")).toEqual({});
    expect(parseStopEnvelope("   ")).toEqual({});
    expect(parseStopEnvelope("not json")).toEqual({});
    expect(parseStopEnvelope("42")).toEqual({});
  });
});

describe("buildTransitionGateStopSettings (ai-home-wlw5l)", () => {
  test("produces a per-session Stop command-hook over the given command", () => {
    const s = buildTransitionGateStopSettings("bun /x/.claude/hooks/transition-gate.ts");
    expect(s.hooks.Stop).toHaveLength(1);
    const handler = s.hooks.Stop[0]!.hooks[0]!;
    expect(handler.type).toBe("command");
    expect(handler.command).toContain("transition-gate.ts");
  });

  test("DEFAULT_TRANSITION_SLOT sits under the .pr/local/runtime session dir", () => {
    expect(DEFAULT_TRANSITION_SLOT).toBe(".pr/local/runtime/transition.json");
  });
});
