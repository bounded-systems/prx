#!/usr/bin/env bun
// prx-g88.2 — PreToolUse policy hook (C2 of docs/capability-orchestrator.md §5).
// Reads the PreToolUse JSON on stdin, resolves the firing subagent's role from
// `agent_type` (C1 names agents by policy role), and denies a Bash command the
// role does not own. Wired per-agent via the generated `hooks:` frontmatter in
// .claude/agents/<role>.md. Pure decision lives in
// packages/prx/src/agents/policy_guard.ts (unit-tested).

import { decideAgentToolCall } from "../../packages/prx/src/agents/policy_guard.ts";

interface PreToolUseInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { command?: string };
  agent_type?: string;
}

const raw = await Bun.stdin.text();
let input: PreToolUseInput;
try {
  input = JSON.parse(raw) as PreToolUseInput;
} catch {
  // Unparseable hook input — never block on our own failure.
  process.exit(0);
}

// Only Bash command calls are policed here.
if (input.tool_name !== "Bash" || !input.tool_input?.command) process.exit(0);

const decision = decideAgentToolCall({
  agentType: input.agent_type,
  command: input.tool_input.command,
});

if (decision.allow) process.exit(0);

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: decision.reason ?? "denied by prx capability policy",
    },
  }),
);
process.exit(2);
