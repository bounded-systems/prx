// prx-g88.3 (C3) — the capability-poor orchestrator profile. The orchestrator is
// delivered by C1 (the generated `orchestrator.md` grants only Agent + reads —
// no Bash) and C2 (the policy guard denies it any policed tool). This test pins
// C3's acceptance criterion in one place: the orchestrator can reach NONE of
// git / gh / bd, and can only delegate.

import { describe, expect, test } from "bun:test";
import { generateOrchestratorDoc } from "../../src/agents/generate.ts";
import { decideAgentToolCall } from "../../src/agents/policy_guard.ts";

describe("capability-poor orchestrator (prx-g88.3)", () => {
  test("grants only Agent + read tools — no Bash, Edit, or Write", () => {
    const tools = /^tools: (.+)$/m.exec(generateOrchestratorDoc())?.[1] ?? "";
    expect(tools).toContain("Agent");
    for (const forbidden of ["Bash", "Edit", "Write", "NotebookEdit"]) {
      expect(tools).not.toContain(forbidden);
    }
  });

  test("declares no PreToolUse hook — it owns nothing to police", () => {
    // The hook is only wired onto role agents (they hold Bash); the orchestrator
    // has no Bash, so it carries no `hooks:` block.
    expect(generateOrchestratorDoc()).not.toContain("hooks:");
  });

  test("is denied every privileged tool — it can only delegate", () => {
    const privileged = [
      "git push origin x",
      "git commit -m x",
      "gh pr merge 1",
      "gh issue create --title x",
      "bd update prx-1 --status=closed",
      "git status", // even reads — the orchestrator owns nothing
    ];
    for (const command of privileged) {
      const d = decideAgentToolCall({ agentType: "orchestrator", command });
      expect(d.allow, `orchestrator should be denied: ${command}`).toBe(false);
      expect(d.reason).toContain("capability-poor");
    }
  });

  test("a non-policed command is not the guard's concern (delegation/echo passes)", () => {
    // The orchestrator's real constraint is tool-level (no Bash at all); the
    // guard only speaks to policed tools, so a bare echo isn't denied by policy.
    expect(decideAgentToolCall({ agentType: "orchestrator", command: "echo delegating" }).allow).toBe(true);
  });
});
