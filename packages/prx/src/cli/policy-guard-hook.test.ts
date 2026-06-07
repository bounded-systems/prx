import { describe, expect, test } from "bun:test";

import { policyGuardHookOutput, readStdin, runHookVerb } from "./policy-guard-hook.ts";

describe("prx hook policy-guard (PreToolUse capability bridge)", () => {
  test("denies a policed command the firing actor doesn't own", () => {
    // The orchestrator is capability-poor and owns no tool.
    const out = policyGuardHookOutput({
      tool_name: "Bash",
      agent_type: "orchestrator",
      tool_input: { command: "git status" },
    });
    expect(out).not.toBeNull();
    const decision = JSON.parse(out!);
    expect(decision.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(decision.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(decision.hookSpecificOutput.permissionDecisionReason).toBeTruthy();
  });

  test("stays silent (allow) outside the policy's scope", () => {
    // No agent_type → main session, out of scope for per-role enforcement.
    expect(
      policyGuardHookOutput({ tool_name: "Bash", tool_input: { command: "git status" } }),
    ).toBeNull();
    // Non-Bash tool calls are never policed here.
    expect(policyGuardHookOutput({ tool_name: "Read", tool_input: { command: "x" } })).toBeNull();
    // A command that isn't a policed tool passes.
    expect(
      policyGuardHookOutput({
        tool_name: "Bash",
        agent_type: "orchestrator",
        tool_input: { command: "echo hi" },
      }),
    ).toBeNull();
    // Missing command → nothing to decide.
    expect(policyGuardHookOutput({ tool_name: "Bash" })).toBeNull();
  });

  test("gates the main session by its declared actor (human / haiku stand-in)", () => {
    // No agent_type (main/interactive session), but a declared session actor
    // (PRX_AGENT_ROLE) → gated exactly like a subagent. The same invariant that
    // sandboxes the human is what lets a cheap haiku agent stand in for them.
    const out = policyGuardHookOutput(
      { tool_name: "Bash", tool_input: { command: "git status" } },
      "orchestrator",
    );
    expect(out).not.toBeNull();
    expect(JSON.parse(out!).hookSpecificOutput.permissionDecision).toBe("deny");

    // Undeclared session (no agent_type, no role) stays out of scope → allow.
    expect(
      policyGuardHookOutput({ tool_name: "Bash", tool_input: { command: "git status" } }),
    ).toBeNull();
  });
});

describe("runHookVerb", () => {
  const sink = () => {
    const logs: string[] = [];
    const errors: string[] = [];
    return { out: { log: (l: string) => logs.push(l), error: (e: string) => errors.push(e) }, logs, errors };
  };
  const denyInput = JSON.stringify({
    tool_name: "Bash",
    agent_type: "orchestrator",
    tool_input: { command: "git status" },
  });

  test("rejects an unknown subcommand with exit 1", async () => {
    const s = sink();
    expect(await runHookVerb(["nope"], s.out, async () => "")).toBe(1);
    expect(s.errors[0]).toMatch(/unknown subcommand "nope"/);
  });

  test("reports (none) when no subcommand is given", async () => {
    const s = sink();
    expect(await runHookVerb([], s.out, async () => "")).toBe(1);
    expect(s.errors[0]).toMatch(/\(none\)/);
  });

  test("logs a deny decision and exits 0", async () => {
    const s = sink();
    expect(await runHookVerb(["policy-guard"], s.out, async () => denyInput)).toBe(0);
    expect(JSON.parse(s.logs[0]!).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("stays silent on an allow and exits 0", async () => {
    const s = sink();
    const allowInput = JSON.stringify({ tool_name: "Bash", tool_input: { command: "git status" } });
    expect(await runHookVerb(["policy-guard"], s.out, async () => allowInput)).toBe(0);
    expect(s.logs).toHaveLength(0);
  });

  test("treats unparseable stdin as a silent allow (exit 0)", async () => {
    const s = sink();
    expect(await runHookVerb(["policy-guard"], s.out, async () => "{ not json")).toBe(0);
    expect(s.logs).toHaveLength(0);
  });
});

describe("readStdin", () => {
  test("drains an async byte stream to a UTF-8 string", async () => {
    async function* stream() {
      yield Buffer.from("hel");
      yield Buffer.from("lo");
    }
    expect(await readStdin(stream())).toBe("hello");
  });
});
