// prx-g88.2 — the runtime enforcement core (C2). Verifies the PreToolUse policy
// decision: ownership boundaries (keeper owns git, forge owns gh), the
// capability-poor orchestrator, hard-blocks, command parsing, and the
// pass-through cases.

import { describe, expect, test } from "bun:test";
import {
  decideAgentToolCall,
  parsePolicedCommand,
} from "../../src/agents/policy_guard.ts";

describe("parsePolicedCommand (prx-g88.2)", () => {
  test("raw git/bd verbs", () => {
    expect(parsePolicedCommand("git push origin foo")).toEqual({ tool: "git", subcommand: "push" });
    expect(parsePolicedCommand("bd close prx-1")).toEqual({ tool: "bd", subcommand: "close" });
  });

  test("gh group word is skipped to reach the verb", () => {
    expect(parsePolicedCommand("gh pr merge 85 --squash")).toEqual({ tool: "gh", subcommand: "merge" });
    expect(parsePolicedCommand("gh issue create --title x")).toEqual({ tool: "gh", subcommand: "create" });
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
});

describe("decideAgentToolCall (prx-g88.2)", () => {
  test("keeper owns git push; forge does not", () => {
    expect(decideAgentToolCall({ agentType: "keeper", command: "git push origin x" }).allow).toBe(true);
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
    expect(decideAgentToolCall({ agentType: "some-other-agent", command: "git push origin x" }).allow).toBe(true);
  });

  test("non-policed and unknown verbs pass through", () => {
    expect(decideAgentToolCall({ agentType: "planner", command: "echo hi" }).allow).toBe(true);
    // `git stash` isn't in the policy vocabulary — not our boundary to enforce.
    expect(decideAgentToolCall({ agentType: "planner", command: "git stash" }).allow).toBe(true);
  });
});
