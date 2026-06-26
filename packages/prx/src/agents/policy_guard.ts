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
const GH_GROUP_WORDS = new Set([
  "pr",
  "issue",
  "repo",
  "release",
  "run",
  "workflow",
  "label",
  "api",
]);

/**
 * Tokens of the command's first pipeline / sequencing segment — the command
 * actually being run. Chained reads after `&&`/`|`/`;` fire their own hook (or
 * are conservatively gated by the head).
 */
function headTokens(command: string): string[] {
  return command
    .trim()
    .split(/\s*(?:\||&&|;)\s*/, 1)[0]!
    .split(/\s+/)
    .filter(Boolean);
}

// Global options that take a VALUE as the next token (space-separated form).
// They must be skipped together with their value when scanning for the verb, or
// the value is mistaken for the subcommand — e.g. `git -C /repo push` must read
// `push`, not `/repo`, and `gh -R o/r pr merge` must read `merge`, not `o/r`.
// The `--opt=value` form is a single token already skipped as an option, so only
// the space form is listed here. (prx-w1v: closing the misparse fail-open.)
const VALUE_OPTS: Partial<Record<PolicyTool, ReadonlySet<string>>> = {
  git: new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]),
  gh: new Set(["-R", "--repo"]),
};

/**
 * The subcommand (verb) among a tool's args: the first non-option token, after
 * skipping leading options and the values of value-taking options, stepping over
 * a gh group word (`pr`/`issue`/…) to reach the real verb. Returns null when the
 * args carry no derivable verb (only options / values) — an unparseable policed
 * command the caller must fail closed on, not pass through.
 */
function subcommandFrom(tool: PolicyTool, args: readonly string[]): string | null {
  const valueOpts = VALUE_OPTS[tool];
  let i = 0;
  while (i < args.length) {
    const tok = args[i]!;
    if (tok.startsWith("-")) {
      i += valueOpts?.has(tok) ? 2 : 1; // skip the option (and its value, if any)
      continue;
    }
    if (tool === "gh" && GH_GROUP_WORDS.has(tok)) {
      const verb = args[i + 1];
      return verb && !verb.startsWith("-") ? verb : null;
    }
    return tok;
  }
  return null;
}

/**
 * Extract the policed `(tool, subcommand)` from a Bash command. Returns null when
 * the command's head is NOT a policed tool — those genuinely pass through — AND
 * when the head IS a policed tool but no subcommand can be derived. Callers tell
 * the two apart with {@link namesPolicedTool} and fail closed on the latter
 * (prx-w1v). Handles raw `git/gh/bd/wt <sub>` and the
 * `prx tools <tool> ... --subcommand <sub>` wrapper shape.
 */
export function parsePolicedCommand(
  command: string,
): { tool: PolicyTool; subcommand: string } | null {
  const tokens = headTokens(command);
  if (tokens.length === 0) return null;

  // `prx tools <tool> ...` wrapper → unwrap to the underlying tool.
  if (tokens[0] === "prx" && tokens[1] === "tools" && tokens[2] && isPolicyTool(tokens[2])) {
    const tool = tokens[2] as PolicyTool;
    const flagIdx = tokens.findIndex((t) => t === "--subcommand");
    const sub = flagIdx >= 0 ? tokens[flagIdx + 1] : tokens[3];
    return sub && !sub.startsWith("-") ? { tool, subcommand: sub } : null;
  }

  const head = tokens[0];
  if (!head || !isPolicyTool(head)) return null;
  const tool = head as PolicyTool;
  const subcommand = subcommandFrom(tool, tokens.slice(1));
  return subcommand === null ? null : { tool, subcommand };
}

/**
 * True when the command's head names a policed tool (`git`/`gh`/`bd`/`prx`/… per
 * `isPolicyTool`), regardless of whether a subcommand parses. Lets the guard
 * distinguish "not a policed tool" (pass through) from "a policed tool we could
 * not parse" (fail closed) — prx-w1v.
 */
export function namesPolicedTool(command: string): boolean {
  const tokens = headTokens(command);
  return tokens.length > 0 && isPolicyTool(tokens[0]!);
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
  if (!parsed) {
    // prx-w1v: a head that names a policed tool but yields no parseable
    // subcommand (`prx tools git`, `git -C /x` with no verb, an option whose
    // value ate the verb) must NOT pass through — it could smuggle a write past
    // the gate. Fail CLOSED for the actors this hook governs; the main session
    // and unknown subagents stay out of scope (pass through), unchanged.
    if (namesPolicedTool(call.command)) {
      if (call.agentType === "orchestrator") {
        return {
          allow: false,
          reason:
            `orchestrator is capability-poor and owns no tool — and \`${call.command}\` names ` +
            `a policed tool with no parseable subcommand (prx-w1v).`,
        };
      }
      if (call.agentType && isPolicyRole(call.agentType)) {
        return {
          allow: false,
          reason:
            `\`${call.command}\` names a policed tool but no subcommand could be parsed — ` +
            `fail closed: the ${call.agentType} actor's ownership cannot be verified (prx-w1v).`,
        };
      }
    }
    return { allow: true };
  }
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
