import { describe, expect, test } from "bun:test";
import {
  checkPolicy,
  isBlocked,
  isFeasibleForRole,
  phaseToState,
  formatPolicyDecision,
} from "@bounded-systems/policy";
import type { PolicyRole, PolicyState } from "@bounded-systems/policy";

describe("isBlocked", () => {
  test("git hard-blocks dangerous commands", () => {
    for (const cmd of ["reset", "clean", "rebase", "cherry-pick", "config", "clone", "init", "remote", "gc"]) {
      expect(isBlocked("git", cmd)).toBe(true);
    }
  });

  test("git does not block safe commands", () => {
    for (const cmd of ["status", "diff", "log", "add", "commit", "push"]) {
      expect(isBlocked("git", cmd)).toBe(false);
    }
  });

  test("gh hard-blocks close and reopen", () => {
    expect(isBlocked("gh", "close")).toBe(true);
    expect(isBlocked("gh", "reopen")).toBe(true);
  });

  test("gh does not block safe commands", () => {
    expect(isBlocked("gh", "status")).toBe(false);
    expect(isBlocked("gh", "view")).toBe(false);
  });
});

describe("checkPolicy", () => {
  test("planning planner can read git", () => {
    const d = checkPolicy("git", "status", "planning", "planner");
    expect(d.allowed).toBe(true);
  });

  test("planning planner cannot git add", () => {
    const d = checkPolicy("git", "add", "planning", "planner");
    expect(d.allowed).toBe(false);
  });

  test("validating executor can git commit", () => {
    const d = checkPolicy("git", "commit", "validating", "executor");
    expect(d.allowed).toBe(true);
  });

  test("planning executor can gh create", () => {
    const d = checkPolicy("gh", "create", "planning", "executor");
    expect(d.allowed).toBe(true);
  });

  test("planning planner cannot gh create", () => {
    const d = checkPolicy("gh", "create", "planning", "planner");
    expect(d.allowed).toBe(false);
  });

  test("validating reviewer can gh review", () => {
    const d = checkPolicy("gh", "review", "validating", "reviewer");
    expect(d.allowed).toBe(true);
  });

  test("prx-gr1: forge owns the full gh write set at every state (the keeper twin)", () => {
    for (const state of ["planning", "validating", "merging"] as const) {
      for (const sub of ["create", "edit", "comment", "review", "merge", "ready"]) {
        expect(checkPolicy("gh", sub, state, "forge").allowed).toBe(true);
      }
    }
    // gh writes that only forge owns: a non-forge role cannot merge/ready.
    expect(checkPolicy("gh", "merge", "merging", "executor").allowed).toBe(false);
    expect(checkPolicy("gh", "ready", "merging", "executor").allowed).toBe(false);
  });

  test("hard-blocked commands are denied regardless of state/role", () => {
    const d = checkPolicy("git", "reset", "merging", "executor");
    expect(d.allowed).toBe(false);
  });

  // GH-1146: lock the bd-update planner-vs-executor matrix shape (the
  // original policy bug surfaced via the retired `triage push-orphans` sweep
  // writing back `external_ref`; the rule itself outlives that verb).
  test("planning planner can bd update", () => {
    const d = checkPolicy("bd", "update", "planning", "planner");
    expect(d.allowed).toBe(true);
  });

  test("planning executor cannot bd update", () => {
    const d = checkPolicy("bd", "update", "planning", "executor");
    expect(d.allowed).toBe(false);
  });

  // GH-1269: policy table was missing `push` for executor at validating +
  // merging, so `prx tools git push` always rejected and executors fell back
  // to raw `git push`. Lock the full 3×4 matrix so accidental expansion
  // (e.g. allowing planner/reviewer/tester push, or push at planning state)
  // fails this suite.
  describe("git push matrix (GH-1269)", () => {
    const STATES: PolicyState[] = ["planning", "validating", "merging"];
    const ROLES: PolicyRole[] = ["planner", "executor", "reviewer", "tester", "keeper"];
    const ALLOWED = new Set<string>([
      "validating:executor",
      "merging:executor",
      // GH-2348.3: keeper is the git-write role — push at validating + merging.
      "validating:keeper",
      "merging:keeper",
    ]);

    for (const state of STATES) {
      for (const role of ROLES) {
        const expected = ALLOWED.has(`${state}:${role}`);
        test(`${state}:${role} → ${expected ? "allow" : "deny"}`, () => {
          const d = checkPolicy("git", "push", state, role);
          expect(d.allowed).toBe(expected);
        });
      }
    }
  });
});

describe("phaseToState", () => {
  test("ready_to_merge maps to merging", () => {
    expect(phaseToState("ready_to_merge")).toBe("merging");
  });

  test("in_review maps to validating", () => {
    expect(phaseToState("in_review")).toBe("validating");
  });

  test("unknown phase maps to planning", () => {
    expect(phaseToState("drafting")).toBe("planning");
    expect(phaseToState("")).toBe("planning");
  });
});

// GH-1239: refusal-symmetry predicate used by `prx plan preflight` and the
// in-session policy gate. Same answers as `checkPolicy`, but with a typed
// reason on refusal so the planner-side surface can distinguish hard-blocks
// from allowlist misses.
describe("isFeasibleForRole", () => {
  test("allowed combinations report feasible", () => {
    const out = isFeasibleForRole("git", "status", "planning", "executor");
    expect(out.feasible).toBe(true);
    expect(out.reason).toBeNull();
  });

  test("hard-blocked subcommands report blocked", () => {
    const out = isFeasibleForRole("gh", "close", "planning", "executor");
    expect(out).toEqual({ feasible: false, reason: "blocked" });
  });

  test("subcommand outside the allowlist for this role reports not-allowlisted-for-role", () => {
    const out = isFeasibleForRole("bd", "update", "planning", "executor");
    expect(out).toEqual({
      feasible: false,
      reason: "not-allowlisted-for-role",
    });
  });

  test("matches the in-session checkPolicy verdict", () => {
    for (const sub of ["status", "create", "checks"] as const) {
      const f = isFeasibleForRole("gh", sub, "planning", "executor");
      const c = checkPolicy("gh", sub, "planning", "executor");
      expect(f.feasible).toBe(c.allowed);
    }
  });
});

describe("formatPolicyDecision", () => {
  test("plain format", () => {
    const d = checkPolicy("git", "status", "planning", "planner");
    const out = formatPolicyDecision(d, "plain");
    expect(out).toContain("allow");
    expect(out).toContain("status");
  });

  test("json format is valid JSON", () => {
    const d = checkPolicy("git", "add", "planning", "planner");
    const json = JSON.parse(formatPolicyDecision(d, "json"));
    expect(json.allowed).toBe(false);
    expect(json.tool).toBe("git");
  });
});
