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
      cwd: "/wt/other-repo",
      servedCwd: "/state/prx/beads",
      localPrefix: () => "other",
      servedPrefix: () => "prx",
    });
    expect(a).toEqual({
      cwdPrefix: "other",
      servedPrefix: "prx",
      cwdRepo: null,
      servedRepo: null,
      mismatch: true,
      reason: "prefix",
    });
  });

  test("match: same prefix is not a mismatch", () => {
    const a = resolveWorkspaceAffinity({
      cwd: "/wt/prx",
      servedCwd: "/state/prx/beads",
      localPrefix: () => "prx",
      servedPrefix: () => "prx",
    });
    expect(a.mismatch).toBe(false);
  });

  // No servedCwd/servedPrefix override: exercises the REAL default
  // (resolveBeadsEndpoint's git-common-dir derivation) end to end. The result
  // depends on the runner's actual repo state (whether beadsd is configured
  // here), so this only asserts the call completes and returns a well-formed
  // result — never crashes, never hangs — not a specific served value.
  test("real defaultServedCwd resolution doesn't throw and returns a well-formed result", () => {
    const a = resolveWorkspaceAffinity({ cwd: "/wt/prx", localPrefix: () => "prx" });
    expect(typeof a.mismatch).toBe("boolean");
    expect(a.cwdPrefix).toBe("prx");
  });

  // No repoIdentity override on the fallback branch: exercises the REAL
  // default (`git remote get-url origin`) against a path with no such remote.
  test("real defaultRepoIdentity resolution on a bogus path returns null, not a throw", () => {
    const a = resolveWorkspaceAffinity({ cwd: "/no/such/path/at/all", localPrefix: () => null });
    expect(a.cwdRepo).toBeNull();
    expect(a.mismatch).toBe(false);
  });

  test("unknown cwd prefix skips the served-prefix subprocess (falls back to repo identity)", () => {
    let servedCalls = 0;
    const a = resolveWorkspaceAffinity({
      cwd: "/tmp/somewhere",
      localPrefix: () => null,
      servedPrefix: () => {
        servedCalls += 1;
        return "prx";
      },
      repoIdentity: () => null, // undeterminable identity → allow
    });
    expect(a.mismatch).toBe(false);
    expect(a.reason).toBeNull();
    expect(servedCalls).toBe(0); // prefix subprocess never runs when cwd prefix is null
  });

  // prx-7odk: identity fallback when the cwd prefix is unresolvable.
  test("identity fallback: unregistered cwd in a DIFFERENT repo is a mismatch", () => {
    const a = resolveWorkspaceAffinity({
      cwd: "/unregistered/other-checkout",
      servedCwd: "/state/prx/beads",
      localPrefix: () => null,
      repoIdentity: (p) => (p === "/unregistered/other-checkout" ? "acme/other-repo" : "bounded-systems/prx"),
    });
    expect(a.mismatch).toBe(true);
    expect(a.reason).toBe("repo");
    expect(a.cwdRepo).toBe("acme/other-repo");
    expect(a.servedRepo).toBe("bounded-systems/prx");
  });

  test("identity fallback: unregistered cwd in the SAME repo is allowed", () => {
    const a = resolveWorkspaceAffinity({
      cwd: "/unregistered/prx-checkout",
      servedCwd: "/state/prx/beads",
      localPrefix: () => null,
      repoIdentity: () => "bounded-systems/prx",
    });
    expect(a.mismatch).toBe(false);
  });

  test("identity fallback: undeterminable cwd identity is allowed AND skips the served lookup", () => {
    let servedRepoCalls = 0;
    const a = resolveWorkspaceAffinity({
      cwd: "/tmp/no-git",
      localPrefix: () => null,
      repoIdentity: (p) => {
        if (p === "/tmp/no-git") return null;
        servedRepoCalls += 1;
        return "bounded-systems/prx";
      },
    });
    expect(a.mismatch).toBe(false);
    expect(servedRepoCalls).toBe(0); // skipped: cwd identity unknown can't mismatch
  });

  test("unknown served prefix is allowed (can't establish a definite mismatch)", () => {
    const a = resolveWorkspaceAffinity({
      cwd: "/wt/prx",
      servedCwd: "/state/prx/beads",
      localPrefix: () => "prx",
      servedPrefix: () => null,
    });
    expect(a.mismatch).toBe(false);
  });

  test("an undeterminable served location (pod socket / no beadsd yet) is allowed", () => {
    let servedCalls = 0;
    const a = resolveWorkspaceAffinity({
      cwd: "/wt/prx",
      servedCwd: null,
      localPrefix: () => "prx",
      servedPrefix: () => {
        servedCalls += 1;
        return "prx";
      },
    });
    expect(a.mismatch).toBe(false);
    expect(a.servedPrefix).toBeNull();
    expect(servedCalls).toBe(0); // nothing to probe — the prefix subprocess never runs
  });

  test("the served-prefix subprocess runs only when the cwd prefix is known", () => {
    let servedCalls = 0;
    resolveWorkspaceAffinity({
      cwd: "/wt/prx",
      servedCwd: "/state/prx/beads",
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
  test("prefix-axis error is fail-closed (exit 1) and names both prefixes + the remedy", () => {
    const e = new WorkspaceAffinityError({
      cwdPrefix: "other",
      servedPrefix: "prx",
      cwdRepo: null,
      servedRepo: null,
      mismatch: true,
      reason: "prefix",
    });
    expect(e.exitCode).toBe(1);
    expect(e.message).toContain('"other"');
    expect(e.message).toContain('"prx"');
    expect(e.message).toContain("PRX_BEADS_CWD");
  });

  test("repo-axis error names both repo identities (identity-fallback message)", () => {
    const e = new WorkspaceAffinityError({
      cwdPrefix: null,
      servedPrefix: null,
      cwdRepo: "acme/other-repo",
      servedRepo: "bounded-systems/prx",
      mismatch: true,
      reason: "repo",
    });
    expect(e.message).toContain("acme/other-repo");
    expect(e.message).toContain("bounded-systems/prx");
    expect(e.message).toContain("PRX_BEADS_CWD");
  });

  test("warning names both prefixes and is non-fatal phrasing", () => {
    const w = workspaceAffinityWarning({ cwdPrefix: "other", servedPrefix: "prx" });
    expect(w).toContain("warning");
    expect(w).toContain('"other"');
    expect(w).toContain('"prx"');
  });
});

describe("readWorkspaceWarning (daemon-reported prefix, no subprocess)", () => {
  test("mismatch → warning string", () => {
    const w = readWorkspaceWarning("prx", { cwd: "/wt/other", localPrefix: () => "other" });
    expect(w).not.toBeNull();
    expect(w).toContain('"other"');
    expect(w).toContain('"prx"');
  });

  test("match → null", () => {
    expect(readWorkspaceWarning("prx", { cwd: "/wt/prx", localPrefix: () => "prx" })).toBeNull();
  });

  test("no served prefix reported → null (daemon didn't wire one)", () => {
    expect(readWorkspaceWarning(undefined, { localPrefix: () => "other" })).toBeNull();
  });

  test("unknown cwd prefix → null (can't establish mismatch)", () => {
    expect(readWorkspaceWarning("prx", { cwd: "/tmp/x", localPrefix: () => null })).toBeNull();
  });
});
