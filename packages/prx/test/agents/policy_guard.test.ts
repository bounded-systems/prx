// prx-g88.2 — the runtime enforcement core (C2). Verifies the PreToolUse policy
// decision: ownership boundaries (keeper owns git, forge owns gh), the
// capability-poor orchestrator, hard-blocks, command parsing, and the
// pass-through cases.

import { describe, expect, test } from "bun:test";
import { decideAgentToolCall, parsePolicedCommand } from "../../src/agents/policy_guard.ts";

describe("parsePolicedCommand (prx-g88.2)", () => {
  test("raw git/bd verbs", () => {
    expect(parsePolicedCommand("git push origin foo")).toEqual({ tool: "git", subcommand: "push" });
    expect(parsePolicedCommand("bd close prx-1")).toEqual({ tool: "bd", subcommand: "close" });
  });

  test("gh group word is skipped to reach the verb", () => {
    expect(parsePolicedCommand("gh pr merge 85 --squash")).toEqual({
      tool: "gh",
      subcommand: "merge",
    });
    expect(parsePolicedCommand("gh issue create --title x")).toEqual({
      tool: "gh",
      subcommand: "create",
    });
  });

  test("the `prx tools <tool> --subcommand <sub>` wrapper unwraps", () => {
    expect(parsePolicedCommand("prx tools bd exec --subcommand remember")).toEqual({
      tool: "bd",
      subcommand: "remember",
    });
  });

  test("non-policed commands return null", () => {
    expect(parsePolicedCommand("echo hi")).toBeNull();
    expect(parsePolicedCommand("bun test")).toBeNull();
    expect(parsePolicedCommand("")).toBeNull();
  });

  test("prx-w1v: value-taking leading options are skipped to reach the verb", () => {
    expect(parsePolicedCommand("git -C /repo push origin x")).toEqual({
      tool: "git",
      subcommand: "push",
    });
    expect(parsePolicedCommand("git -c user.name=x commit -m y")).toEqual({
      tool: "git",
      subcommand: "commit",
    });
    expect(parsePolicedCommand("git --git-dir /x/.git push")).toEqual({
      tool: "git",
      subcommand: "push",
    });
    expect(parsePolicedCommand("gh -R o/r pr merge 9")).toEqual({
      tool: "gh",
      subcommand: "merge",
    });
    expect(parsePolicedCommand("gh --repo o/r issue create")).toEqual({
      tool: "gh",
      subcommand: "create",
    });
  });

  test("prx-w1v: a policed tool with no derivable verb returns null", () => {
    expect(parsePolicedCommand("git")).toBeNull();
    expect(parsePolicedCommand("git -C /repo")).toBeNull(); // option consumed the only token
    expect(parsePolicedCommand("prx tools git")).toBeNull(); // wrapper, no subcommand
    expect(parsePolicedCommand("prx tools git --subcommand")).toBeNull(); // flag, no value
    expect(parsePolicedCommand("gh -R o/r")).toBeNull();
  });
});

describe("decideAgentToolCall (prx-g88.2)", () => {
  test("keeper owns git push; forge does not", () => {
    expect(decideAgentToolCall({ agentType: "keeper", command: "git push origin x" }).allow).toBe(
      true,
    );
    const denied = decideAgentToolCall({ agentType: "forge", command: "git push origin x" });
    expect(denied.allow).toBe(false);
    expect(denied.reason).toContain("forge actor does not own");
  });

  test("forge owns gh merge; executor does not", () => {
    expect(decideAgentToolCall({ agentType: "forge", command: "gh pr merge 85" }).allow).toBe(true);
    const denied = decideAgentToolCall({ agentType: "executor", command: "gh pr merge 85" });
    expect(denied.allow).toBe(false);
    expect(denied.reason).toContain("executor actor does not own");
  });

  test("git reads are allowed for git-capable roles", () => {
    for (const role of ["planner", "reviewer", "tester", "keeper", "executor"]) {
      expect(decideAgentToolCall({ agentType: role, command: "git status" }).allow).toBe(true);
    }
  });

  test("forge owns gh only — it has no git rows, so even `git status` is denied", () => {
    const d = decideAgentToolCall({ agentType: "forge", command: "git status" });
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("forge actor does not own");
    // ...but forge freely reads gh.
    expect(decideAgentToolCall({ agentType: "forge", command: "gh pr view 1" }).allow).toBe(true);
  });

  test("the capability-poor orchestrator is denied any policed tool", () => {
    const d = decideAgentToolCall({ agentType: "orchestrator", command: "git status" });
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("capability-poor");
  });

  test("hard-blocked subcommands are denied regardless of role", () => {
    const d = decideAgentToolCall({ agentType: "keeper", command: "git reset --hard HEAD~1" });
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("hard-blocked");
  });

  test("main session (no agent_type) and unknown subagents pass through", () => {
    expect(decideAgentToolCall({ command: "git push origin x" }).allow).toBe(true);
    expect(
      decideAgentToolCall({ agentType: "some-other-agent", command: "git push origin x" }).allow,
    ).toBe(true);
  });

  test("non-policed and unknown verbs pass through", () => {
    expect(decideAgentToolCall({ agentType: "planner", command: "echo hi" }).allow).toBe(true);
    // `git stash` isn't in the policy vocabulary — not our boundary to enforce.
    expect(decideAgentToolCall({ agentType: "planner", command: "git stash" }).allow).toBe(true);
  });
});

describe("decideAgentToolCall — prx-w1v fail-closed parsing", () => {
  // The misparse bypass: a value-taking option used to swallow the verb, so the
  // real write read as an unknown subcommand and passed through. Now the verb is
  // found and ownership is enforced.
  test("a non-owning role cannot smuggle a write behind `-C` / `-R`", () => {
    expect(
      decideAgentToolCall({ agentType: "reviewer", command: "git -C /repo push origin x" }).allow,
    ).toBe(false);
    expect(
      decideAgentToolCall({ agentType: "executor", command: "gh -R o/r pr merge 9" }).allow,
    ).toBe(false);
  });

  test("the owning actor still passes with leading options (no over-deny)", () => {
    expect(
      decideAgentToolCall({ agentType: "keeper", command: "git -C /repo push origin x" }).allow,
    ).toBe(true);
    expect(decideAgentToolCall({ agentType: "forge", command: "gh -R o/r pr merge 9" }).allow).toBe(
      true,
    );
    // a read with a leading option stays allowed for a git-capable role
    expect(
      decideAgentToolCall({ agentType: "reviewer", command: "git -C /repo status" }).allow,
    ).toBe(true);
  });

  test("an unparseable policed command fails closed for policy roles", () => {
    for (const command of [
      "prx tools git",
      "prx tools git --subcommand",
      "git",
      "git -C /repo",
      "gh -R o/r",
    ]) {
      const d = decideAgentToolCall({ agentType: "reviewer", command });
      expect(d.allow, `"${command}" should fail closed`).toBe(false);
      expect(d.reason).toContain("prx-w1v");
    }
  });

  test("unparseable policed fails closed for the orchestrator too", () => {
    const d = decideAgentToolCall({ agentType: "orchestrator", command: "prx tools git" });
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("capability-poor");
  });

  test("out of scope: main session + unknown subagents still pass through", () => {
    expect(decideAgentToolCall({ command: "prx tools git" }).allow).toBe(true);
    expect(decideAgentToolCall({ agentType: "some-other-agent", command: "git -C /x" }).allow).toBe(
      true,
    );
  });

  test("non-policed unparseable still passes (not our boundary)", () => {
    expect(decideAgentToolCall({ agentType: "reviewer", command: "echo" }).allow).toBe(true);
  });
});
