// prx-1dz — the verification spine of the delegation DAG
// (docs/capability-orchestrator.md §2). The full edge-recording —
// `D_A.inputs["delegate:B/<call>"] = D_B.derivationId` into a parent agent-run /
// merge derivation — lands with `merge/v1` (filed as the follow-up). This module
// ships the half that has teeth NOW: given a privileged EFFECT derivation, the
// `producer` actor must be a policy-table OWNER of that effect.
//
//   ambient authority := a privileged output not produced by its owning actor.
//
// A `push/v1` produced by `reviewer`, or (once gh effects are attested) a `gh
// merge` by `executor`, is an orphan effect → fail closed. The owner set comes
// straight from the policy table (`findOwningRoles`), so this tightens
// automatically as prx-gr1 narrows git custody to keeper.
//
// Pure + unwired: callers (e.g. the merge-guard) opt in. Default behavior of the
// live pipeline is unchanged until a gate adopts it.

import {
  POLICY_ROLES,
  POLICY_STATES,
  findOwningRoles,
  isBlocked,
  type PolicyRole,
  type PolicyTool,
} from "@bounded-systems/policy";
import type { Derivation } from "@bounded-systems/anchored-chain";
import { actorFromBuilderId } from "./signer.ts";

export interface EffectKind {
  readonly tool: PolicyTool;
  readonly subcommand: string;
}

export interface EffectOwnershipResult {
  /** True = owned correctly OR not an enforced effect. False = orphan/ambient effect. */
  readonly ok: boolean;
  /** Present on a real failure — the orphan-effect explanation. */
  readonly reason?: string;
  /** The policed effect, when the derivation is one. */
  readonly effect?: EffectKind;
  /** The producer's actor (from the builder id). */
  readonly actor?: string | null;
  /** The roles that own this effect per the policy table. */
  readonly owners?: PolicyRole[];
}

function isPolicyRole(value: string): value is PolicyRole {
  return (POLICY_ROLES as readonly string[]).includes(value);
}

/**
 * The policed `(tool, subcommand)` an effect derivation represents, or null when
 * it isn't an enforced effect. Today the attested effects are git `commit`/`push`
 * (attestingGit records `params.subcommand`); the gh custody effects join here
 * once forge attests them.
 */
export function effectKindOf(derivation: Derivation): EffectKind | null {
  const sub = derivation.manifest.params?.["subcommand"];
  if (typeof sub === "string" && sub.length > 0) {
    return { tool: "git", subcommand: sub };
  }
  return null;
}

/** Union, across all states, of the roles that own an effect per the policy table. */
function owningRolesUnion(tool: PolicyTool, subcommand: string): PolicyRole[] {
  const acc = new Set<PolicyRole>();
  for (const state of POLICY_STATES) {
    for (const role of findOwningRoles(tool, subcommand, state)) acc.add(role);
  }
  return [...acc];
}

/**
 * Verify a privileged effect derivation was produced by an owning actor. Returns
 * `ok: true` for non-effect derivations and for effects whose producer is an
 * owning role. Returns `ok: false` (orphan/ambient effect) when a known policy
 * role produced an effect it doesn't own, when the effect is hard-blocked, or
 * when the producer's actor can't be parsed.
 *
 * A producer whose actor is NOT a policy-role name (e.g. a session-profile
 * actor like `work`/`implement`) is passed through in v1 — mapping those to
 * their role needs the profile→role table and is a tracked follow-up. The
 * custody actors that matter most (keeper, forge) are role-named, so they are
 * enforced strictly.
 */
export function verifyEffectOwnership(derivation: Derivation): EffectOwnershipResult {
  const effect = effectKindOf(derivation);
  if (!effect) return { ok: true };
  const { tool, subcommand } = effect;

  if (isBlocked(tool, subcommand)) {
    return {
      ok: false,
      effect,
      reason: `${tool} ${subcommand} is hard-blocked, yet a signed effect derivation exists`,
    };
  }

  const actor = actorFromBuilderId(derivation.manifest.producer);
  const owners = owningRolesUnion(tool, subcommand);
  if (actor === null) {
    return {
      ok: false,
      effect,
      actor,
      owners,
      reason: `producer '${derivation.manifest.producer}' has no parseable actor`,
    };
  }

  // Non-role actor (session-profile name) — can't map to a role yet; pass through.
  if (!isPolicyRole(actor)) return { ok: true, effect, actor, owners };

  if (owners.includes(actor)) return { ok: true, effect, actor, owners };

  return {
    ok: false,
    effect,
    actor,
    owners,
    reason:
      `${tool} ${subcommand} was produced by '${actor}', which does not own it ` +
      `(owners: ${owners.length ? owners.join(", ") : "none"}) — orphan/ambient effect`,
  };
}

/**
 * The canonical key for a delegation edge in a parent derivation's `inputs`
 * (`delegate:<actor>/<call>`). Pinned here so the recorder (with `merge/v1`) and
 * any walker agree on the format before the emitter exists.
 */
export function delegationInputKey(actor: string, call: string): string {
  return `delegate:${actor}/${call}`;
}
