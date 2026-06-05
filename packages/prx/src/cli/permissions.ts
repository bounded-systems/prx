/**
 * SPIKE — permission projection: a verb's `actor` drives its tool policy on
 * every surface. This is the capability model (GH-1530 "each actor gets a
 * unique, registry-derived permission ruleset") expressed as one more
 * projection of the registry:
 *
 *   VerbSpec.actor ──▶ ToolPolicy {allow, deny}
 *         ├─ CLI flag-layer    ──▶ --allowedTools / --disallowedTools
 *         └─ plugin command    ──▶ allowed-tools frontmatter
 *
 * One policy table, applied wherever the verb runs an agent — so the CLI's
 * flag-layer and the plugin's slash-command grant the SAME authority. Mirrors
 * the spirit of `roleProfile` (pilot.ts) one level up, at the actor.
 */

import type { VerbSpec } from "./verbspec.ts";

export type ToolPolicy = { allow: readonly string[]; deny: readonly string[] };
export type ActorPolicies = Record<string, ToolPolicy>;

/** Least authority: read/search only, no mutation. The fallback for any actor. */
export const READ_ONLY: ToolPolicy = {
  allow: ["Read", "Grep", "Glob"],
  deny: ["Edit", "Write", "Bash(git:*)", "Bash(gh:*)"],
};

/**
 * Default per-actor policy for the orchestrator + pipeline actors. Orchestrators
 * (pilot/fleet) and the planning actors read + drive `prx`, but never mutate
 * directly — mutation is delegated to the actors the pipeline invokes, each
 * signed. Unknown actors fall back to {@link READ_ONLY}.
 */
export const defaultActorPolicies: ActorPolicies = {
  pilot: { allow: ["Read", "Grep", "Glob", "Bash(prx:*)"], deny: ["Edit", "Write"] },
  fleet: { allow: ["Read", "Grep", "Glob", "Bash(prx:*)"], deny: ["Edit", "Write"] },
  plan: { allow: ["Read", "Grep", "Glob"], deny: ["Edit", "Write", "Bash(git:*)"] },
  intake: { allow: ["Read", "Grep", "Glob", "Bash(prx:*)"], deny: ["Edit", "Write"] },
  triage: { allow: ["Read", "Grep", "Glob", "Bash(prx:*)"], deny: ["Edit", "Write"] },
};

/** The verb's tool policy, from its actor (READ_ONLY fallback). */
export function verbToolPolicy(v: VerbSpec, policies: ActorPolicies = defaultActorPolicies): ToolPolicy {
  return policies[v.actor] ?? READ_ONLY;
}

/** CLI flag-layer projection (matches the runtime-profile flag shape). */
export function toCliPermissionFlags(v: VerbSpec, policies?: ActorPolicies): string[] {
  const p = verbToolPolicy(v, policies);
  const flags: string[] = [];
  if (p.allow.length) flags.push("--allowedTools", p.allow.join(","));
  if (p.deny.length) flags.push("--disallowedTools", p.deny.join(","));
  return flags;
}

/**
 * The `allowed-tools` list for a plugin slash command: the verb's own MCP tool
 * plus the actor's allowed tools. (Slash-command frontmatter has no deny list;
 * deny is enforced by omission — only `allow` is granted.)
 */
export function pluginAllowedTools(
  v: VerbSpec,
  ownTool: string,
  policies?: ActorPolicies,
): string[] {
  return [ownTool, ...verbToolPolicy(v, policies).allow];
}
