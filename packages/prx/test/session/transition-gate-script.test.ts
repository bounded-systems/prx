import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// End-to-end glue test for the Stop-hook script: spawn it the way Claude Code
// would (env + a slot path) and assert the exit contract. The block path
// (missing slot) exercises env → slot read → gate → exit 2 without writing CAS.
const scriptPath = join(import.meta.dir, "../../scripts/hooks/transition-gate.ts");

describe("transition-gate Stop-hook script (ai-home-wlw5l)", () => {
  test("a missing slot blocks termination: exit 2 + 'no transition artifact' on stderr", () => {
    const r = spawnSync("bun", [scriptPath], {
      // Mock the Stop-hook stdin envelope (the script reads it).
      input: JSON.stringify({ hook_event_name: "Stop", session_id: "test", cwd: "/tmp" }),
      env: {
        ...process.env,
        PRX_AGENT_ROLE: "executor",
        PRX_WORK_UNIT: "GH-1",
        PRX_TRANSITION_SLOT: "/nonexistent/does-not-exist/transition.json",
      },
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("no transition artifact emitted");
    expect(r.stderr).toContain("executor/GH-1");
  });
});
