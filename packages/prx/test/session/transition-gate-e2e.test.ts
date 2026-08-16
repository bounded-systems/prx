import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getRef, readBlob } from "../../src/plan-store/cas.ts";

// End-to-end proof of the agent-run gate (ai-home-wlw5l): run the REAL Stop-hook
// script exactly as Claude Code would (env + a slot file), against an isolated
// temp CAS (PRX_CAS_ROOT), and confirm the allow path actually pins the typed
// artifact to CAS and exits 0. This exercises the full merged chain —
// script → runTransitionGateHook → evaluateTransitionGate → pinTransitionArtifact
// → writeBlob/setRef — minus only Claude Code's documented hook-firing.
const scriptPath = join(import.meta.dir, "../../scripts/hooks/transition-gate.ts");

afterEach(() => {
  delete process.env.PRX_CAS_ROOT;
});

describe("transition-gate end-to-end (ai-home-wlw5l)", () => {
  test("a valid slot → the hook pins the artifact to CAS and exits 0 (allow)", async () => {
    const casRoot = mkdtempSync(join(tmpdir(), "prx-cas-"));
    const slot = join(mkdtempSync(join(tmpdir(), "prx-slot-")), "transition.json");
    writeFileSync(slot, JSON.stringify({ status: "ready", note: "e2e" }));

    const r = spawnSync("bun", [scriptPath], {
      input: JSON.stringify({ hook_event_name: "Stop", session_id: "e2e", cwd: casRoot }),
      env: {
        ...process.env,
        PRX_AGENT_ROLE: "executor",
        PRX_WORK_UNIT: "GH-e2e",
        PRX_TRANSITION_SLOT: slot,
        PRX_CAS_ROOT: casRoot,
      },
      encoding: "utf8",
    });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain("executor://sha256:");

    // Prove the artifact is really in CAS: resolve the ref + read the blob back.
    process.env.PRX_CAS_ROOT = casRoot;
    const sha = await getRef("transition:executor:GH-e2e", { domain: "executor" });
    expect(sha).toBeTruthy();
    const blob = await readBlob(sha!, { domain: "executor" });
    expect(JSON.parse(blob.toString())).toEqual({ status: "ready", note: "e2e" });
  });

  test("an empty slot → the hook blocks (exit 2) and pins nothing", async () => {
    const casRoot = mkdtempSync(join(tmpdir(), "prx-cas-"));
    const slot = join(mkdtempSync(join(tmpdir(), "prx-slot-")), "transition.json");
    writeFileSync(slot, "   ");

    const r = spawnSync("bun", [scriptPath], {
      input: JSON.stringify({ hook_event_name: "Stop", session_id: "e2e", cwd: casRoot }),
      env: {
        ...process.env,
        PRX_AGENT_ROLE: "executor",
        PRX_WORK_UNIT: "GH-e2e",
        PRX_TRANSITION_SLOT: slot,
        PRX_CAS_ROOT: casRoot,
      },
      encoding: "utf8",
    });

    expect(r.status).toBe(2);
    expect(r.stderr).toContain("no transition artifact emitted");
    process.env.PRX_CAS_ROOT = casRoot;
    expect(await getRef("transition:executor:GH-e2e", { domain: "executor" })).toBeNull();
  });
});
