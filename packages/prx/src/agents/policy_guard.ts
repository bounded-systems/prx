// prx-g88.2 — runtime policy enforcement for actor sub-agents (C2 of the
// capability epic, docs/capability-orchestrator.md §5). The PreToolUse hook
// (.claude/hooks/policy-guard.ts) calls this pure core with the firing
// subagent's identity (`agent_type`, which C1 names by policy role) and the
// Bash command, and denies the call when the role does not own the
// (tool, subcommand). This is the runtime half of the projection: C1 generated
// the per-role allowlist docs; here we ENFORCE them on raw commands a subagent
// might run directly (bypassing the self-policing `prx tools` wrappers).
//
// State note: enforcement is on the union across states (role OWNERSHIP), so the
// gate needs no phase context. State-aware tightening is a refinement.

import {
  POLICY_ROLES,
  allowedSubcommands,
  isBlocked,
  isKnownSubcommand,
  isPolicyTool,
  type PolicyRole,
  type PolicyTool,
} from "@bounded-systems/policy";

export interface AgentToolCall {
  /** The firing subagent's name (PreToolUse `agent_type`). Undefined = main session. */
  agentType?: string;
  /** The Bash command the subagent is trying to run. */
  command: string;
}

export interface PolicyGuardDecision {
  allow: boolean;
  /** Present on deny — shown to the model as the permissionDecisionReason. */
  reason?: string;
  /** The parsed (tool, subcommand), when the command was policed. */
  parsed?: { tool: PolicyTool; subcommand: string };
}

function isPolicyRole(value: string): value is PolicyRole {
  return (POLICY_ROLES as readonly string[]).includes(value);
}

// gh group words that precede the real verb (`gh pr merge` → merge). The policy
// vocabulary keys on the verb, not the group (the group check lives in the gh
// tool layer).
const GH_GROUP_WORDS = new Set(["pr", "issue", "repo", "release", "run", "workflow", "label", "api"]);

/**
 * Extract the policed `(tool, subcommand)` from a Bash command, or null when the
 * command isn't a policy-relevant tool invocation. Handles raw `git/gh/bd/wt
 * <sub>` and the `prx tools <tool> ... --subcommand <sub>` wrapper shape.
 */
export function parsePolicedCommand(
  command: string,
): { tool: PolicyTool; subcommand: string } | null {
  const tokens = command
    .trim()
    // Only inspect the first pipeline / sequencing segment — that's the command
    // actually being run; chained reads after `&&`/`|` are matched on their own
    // hook fire if they're separate, and we conservatively gate the head.
    .split(/\s*(?:\||&&|;)\s*/, 1)[0]!
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return null;

  let rest = tokens;
  // `prx tools <tool> ...` wrapper → unwrap to the underlying tool.
  if (rest[0] === "prx" && rest[1] === "tools" && rest[2] && isPolicyTool(rest[2])) {
    const tool = rest[2] as PolicyTool;
    const flagIdx = rest.findIndex((t) => t === "--subcommand");
    const sub = flagIdx >= 0 ? rest[flagIdx + 1] : rest[3];
    return sub ? { tool, subcommand: stripGhGroup(tool, [sub]) } : null;
  }

  const head = rest[0];
  if (!head || !isPolicyTool(head)) return null;
  const tool = head as PolicyTool;
  const args = rest.slice(1).filter((t) => !t.startsWith("-"));
  if (args.length === 0) return null;
  return { tool, subcommand: stripGhGroup(tool, args) };
}

/** For gh, skip a leading group word (`pr`/`issue`/...) to reach the verb. */
function stripGhGroup(tool: PolicyTool, args: string[]): string {
  if (tool === "gh" && args.length >= 2 && GH_GROUP_WORDS.has(args[0]!)) {
    return args[1]!;
  }
  return args[0]!;
}

/**
 * Decide whether a subagent may run a Bash command. Deny when:
 *  - the subagent is the capability-poor `orchestrator` running any policed tool;
 *  - the (tool, subcommand) is hard-blocked;
 *  - the role is a known policy role and the policed subcommand is not in its
 *    allowlist (union across states).
 * Allow (pass-through) for the main session, unknown subagents, non-policed
 * commands, and unknown subcommands the policy doesn't speak to.
 */
export function decideAgentToolCall(call: AgentToolCall): PolicyGuardDecision {
  const parsed = parsePolicedCommand(call.command);
  if (!parsed) return { allow: true };
  const { tool, subcommand } = parsed;

  // The orchestrator owns nothing — any policed tool is a delegation it skipped.
  if (call.agentType === "orchestrator") {
    return {
      allow: false,
      parsed,
      reason:
        `orchestrator is capability-poor and owns no tool — delegate \`${tool} ${subcommand}\` ` +
        `to the owning actor (docs/capability-orchestrator.md §1).`,
    };
  }

  if (isBlocked(tool, subcommand)) {
    return {
      allow: false,
      parsed,
      reason: `\`${tool} ${subcommand}\` is hard-blocked for every role.`,
    };
  }

  // Only enforce for known policy roles; other subagents / the main session are
  // out of scope for this hook.
  if (!call.agentType || !isPolicyRole(call.agentType)) return { allow: true, parsed };
  const role = call.agentType;

  // Only police verbs the policy actually speaks to; unknown verbs pass.
  if (!isKnownSubcommand(tool, subcommand)) return { allow: true, parsed };

  if (allowedSubcommands(tool, role).includes(subcommand)) return { allow: true, parsed };

  return {
    allow: false,
    parsed,
    reason:
      `the ${role} actor does not own \`${tool} ${subcommand}\` — delegate it to the owning actor ` +
      `(see .claude/agents/${role}.md; docs/capability-orchestrator.md §1).`,
  };
}
