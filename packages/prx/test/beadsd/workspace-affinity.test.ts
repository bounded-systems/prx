import { describe, expect, test } from "bun:test";

import {
  resolveWorkspaceAffinity,
  WorkspaceAffinityError,
  workspaceAffinityWarning,
  readWorkspaceWarning,
} from "../../src/beadsd/workspace-affinity.ts";

describe("resolveWorkspaceAffinity (prx-9e86)", () => {
  test("definite mismatch: cwd prefix != served prefix", () => {
    const a = resolveWorkspaceAffinity({
      cwd: "/wt/supply-plan-design",
      servedCwd: "/state/prx/beads",
      localPrefix: () => "spd",
      servedPrefix: () => "prx",
    });
    expect(a).toEqual({ cwdPrefix: "spd", servedPrefix: "prx", mismatch: true });
  });

  test("match: same prefix is not a mismatch", () => {
    const a = resolveWorkspaceAffinity({
      cwd: "/wt/prx",
      localPrefix: () => "prx",
      servedPrefix: () => "prx",
    });
    expect(a.mismatch).toBe(false);
  });

  test("unknown cwd prefix is allowed AND skips the served-prefix subprocess", () => {
    let servedCalls = 0;
    const a = resolveWorkspaceAffinity({
      cwd: "/tmp/somewhere",
      localPrefix: () => null,
      servedPrefix: () => {
        servedCalls += 1;
        return "prx";
      },
    });
    expect(a).toEqual({ cwdPrefix: null, servedPrefix: null, mismatch: false });
    expect(servedCalls).toBe(0); // gated: never resolved when cwd prefix is null
  });

  test("unknown served prefix is allowed (can't establish a definite mismatch)", () => {
    const a = resolveWorkspaceAffinity({
      cwd: "/wt/prx",
      localPrefix: () => "prx",
      servedPrefix: () => null,
    });
    expect(a.mismatch).toBe(false);
  });

  test("the served-prefix subprocess runs only when the cwd prefix is known", () => {
    let servedCalls = 0;
    resolveWorkspaceAffinity({
      cwd: "/wt/prx",
      localPrefix: () => "prx",
      servedPrefix: () => {
        servedCalls += 1;
        return "prx";
      },
    });
    expect(servedCalls).toBe(1);
  });
});

describe("WorkspaceAffinityError + warning", () => {
  test("error is fail-closed (exit 1) and names both prefixes + the remedy", () => {
    const e = new WorkspaceAffinityError({ cwdPrefix: "spd", servedPrefix: "prx" });
    expect(e.exitCode).toBe(1);
    expect(e.message).toContain('"spd"');
    expect(e.message).toContain('"prx"');
    expect(e.message).toContain("PRX_BEADS_CWD");
  });

  test("warning names both prefixes and is non-fatal phrasing", () => {
    const w = workspaceAffinityWarning({ cwdPrefix: "spd", servedPrefix: "prx" });
    expect(w).toContain("warning");
    expect(w).toContain('"spd"');
    expect(w).toContain('"prx"');
  });
});

describe("readWorkspaceWarning (daemon-reported prefix, no subprocess)", () => {
  test("mismatch → warning string", () => {
    const w = readWorkspaceWarning("prx", { cwd: "/wt/spd", localPrefix: () => "spd" });
    expect(w).not.toBeNull();
    expect(w).toContain('"spd"');
    expect(w).toContain('"prx"');
  });

  test("match → null", () => {
    expect(readWorkspaceWarning("prx", { cwd: "/wt/prx", localPrefix: () => "prx" })).toBeNull();
  });

  test("no served prefix reported → null (daemon didn't wire one)", () => {
    expect(readWorkspaceWarning(undefined, { localPrefix: () => "spd" })).toBeNull();
  });

  test("unknown cwd prefix → null (can't establish mismatch)", () => {
    expect(readWorkspaceWarning("prx", { cwd: "/tmp/x", localPrefix: () => null })).toBeNull();
  });
});
