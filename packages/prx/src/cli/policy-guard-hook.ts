/**
 * `prx hook policy-guard` — the capability bridge between Claude Code and prx.
 *
 * Wired as a plugin `PreToolUse:Bash` hook. Claude Code pipes the tool-call JSON
 * on stdin; we resolve the firing actor from `agent_type` (a prx actor-subagent)
 * and run it through the same `decideAgentToolCall` policy that governs prx's own
 * sessions. A deny returns a `permissionDecision` so Claude Code blocks the call;
 * an allow is silent (exit 0, normal permission flow). The runtime owns the
 * policy — the plugin just points the hook at this verb.
 */

import { getEnv } from "@bounded-systems/env";

import { decideAgentToolCall } from "../agents/policy_guard.ts";

/** PreToolUse hook input — only the fields the policy guard reads. */
export type PolicyGuardHookInput = {
  tool_name?: string;
  agent_type?: string;
  tool_input?: { command?: string };
};

/**
 * The hook's stdout for one tool call: a `deny` decision JSON, or `null` to stay
 * silent (allow / out of scope). Pure — the stdin/stdout plumbing is in
 * {@link runHookVerb}, so this is unit-testable without a pipe.
 */
export function policyGuardHookOutput(
  input: PolicyGuardHookInput,
  sessionActor?: string,
): string | null {
  const command = input.tool_input?.command;
  if (input.tool_name !== "Bash" || !command) return null;

  // The firing actor: a subagent's `agent_type`, else the session's declared
  // human actor (`PRX_AGENT_ROLE`). Treating the human as a sandboxed actor is
  // the invariant — no privileged escape: the same capability policy that
  // bounds the subagents bounds the human-in-the-loop. An undeclared session
  // (no agent_type, no role) stays out of scope → allow.
  const agentType = input.agent_type ?? sessionActor;
  const decision = decideAgentToolCall({
    ...(agentType !== undefined ? { agentType } : {}),
    command,
  });
  if (decision.allow) return null;

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: decision.reason ?? "blocked by prx capability policy",
    },
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** `prx hook <sub>` — only `policy-guard` is defined. */
export async function runHookVerb(
  args: readonly string[],
  output: { log: (line: string) => void; error: (line: string) => void },
): Promise<number> {
  const [sub] = args;
  if (sub !== "policy-guard") {
    output.error(`prx hook: unknown subcommand ${sub ? `"${sub}"` : "(none)"} — expected "policy-guard"`);
    return 1;
  }

  let input: PolicyGuardHookInput;
  try {
    input = JSON.parse(await readStdin()) as PolicyGuardHookInput;
  } catch {
    return 0; // unparseable input → don't block; normal permission flow applies
  }

  // `PRX_AGENT_ROLE` declares the session's actor — so an interactive/main
  // session is gated as a sandboxed actor (the human, or a haiku stand-in in
  // tests), not an unscoped escape hatch. A subagent's `agent_type` wins.
  const decision = policyGuardHookOutput(input, getEnv("PRX_AGENT_ROLE"));
  if (decision) output.log(decision);
  return 0;
}
