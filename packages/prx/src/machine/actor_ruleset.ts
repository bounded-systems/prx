// Registry-derived per-actor permission helper (GH-1530, object-capability
// redesign). Replaces the hand-listed `allowedTools` / `disallowedTools`
// arrays in `runtime_profiles.ts` with a single helper keyed on an actor's
// canonical name. An actor's session may run ONLY its own namespace directly
// (`Bash(prx <actor>:*)`) plus a shared base toolset, and every raw
// `gh`/`bd`/`git` / search-shell is denied by default. Cross-namespace reach
// is governed by dispatch (`prx <source> dispatch --actor=<target> -- <verb>`),
// not by widening an actor's own allowlist.
//
// Why this is "registry-derived": the own-namespace grant is a glob over the
// actor's CLI namespace (`Bash(prx <actor>:*)`), so adding a `CommandSpec`
// under an actor makes its verb runnable in that actor's session with zero
// `runtime_profiles.ts` edits (AC4). The `actor` argument is validated against
// the `actor_names.ts` leaf — the same canonical vocabulary the CLI registry's
// `ActorName` enum and the dispatch taxonomy consume — so a typo fails loud.
//
// Cycle-safety: this module imports ONLY the `actor_names.ts` leaf (no `zod`,
// no `registry.ts`, no `registry.data.ts`). The leaf has no runtime deps, so
// `runtime_profiles.ts` importing `actorRuleset` cannot reintroduce the
// registry → runtime_profiles ESM cycle the plan flagged. (Validating against
// the leaf rather than `commandsByActor` is also the only correct choice for
// the `implement` profile, whose `prx implement` commands are owned by the
// `work` actor, leaving `commandsByActor("implement")` empty by design.)

import { actorNames, type ActorName } from "./actor_names.ts";

/**
 * Role posture for the base toolset. `reader` profiles inspect only; `executor`
 * profiles additionally edit files, track tasks, and run the project's `bun`
 * verifications. The role governs ONLY the base allow set and the Edit/Write
 * deny — the shared raw-CLI / search-shell deny applies to every role.
 */
export type RulesetRole = "reader" | "executor";

export const BASE_TOOLS_BY_ROLE: Readonly<Record<RulesetRole, readonly string[]>> = Object.freeze({
  reader: Object.freeze(["Read", "Grep", "Glob"]),
  executor: Object.freeze([
    "Read",
    "Grep",
    "Glob",
    "Edit",
    "Write",
    "TodoWrite",
    "TaskCreate",
    "TaskUpdate",
    "TaskList",
    "Bash(bun test:*)",
    "Bash(bun run:*)",
    "Bash(bun typecheck:*)",
  ]),
});

/**
 * Deny set every ruleset shares (GH-1530). Blocks the raw CLIs that must route
 * through `prx tools <cli>` wrappers (or be reached via dispatch), the
 * destructive git verbs, the search shells (Claude has native Read/Grep/Glob),
 * `rm`, and recursive session entry. Edit/Write are NOT here — they are a
 * role-specific deny (readers deny them; executors allow them) layered by
 * `actorRuleset`.
 *
 * A deny here does NOT shadow the `prx tools git|bd` wrappers or own-namespace
 * verbs: the permission matcher keys on the command head (`prx`), so
 * `Bash(prx tools git:*)` survives the `Bash(git:*)` blanket.
 */
export const SHARED_DENY: readonly string[] = Object.freeze([
  "Bash(gh:*)",
  "Bash(bd:*)",
  "Bash(git:*)",
  "Bash(git push:*)",
  "Bash(git reset:*)",
  "Bash(git commit:*)",
  "Bash(git rebase:*)",
  "Bash(grep:*)",
  "Bash(find:*)",
  "Bash(rg:*)",
  "Bash(rm:*)",
  "Bash(prx plan agent --create:*)",
]);

export interface ActorRulesetOptions {
  /** Base posture. Default `"reader"`. */
  role?: RulesetRole;
  /**
   * Additional allow entries layered on top of the base + own-namespace glob.
   * Used (transitionally, GH-1530 PR-3) for the sanctioned `prx tools <cli>`
   * wrappers and the cross-namespace `prx <verb>` grants that have not yet been
   * migrated to dispatch. These are the documented exceptions — everything
   * else is base + own namespace.
   */
  extraAllow?: readonly string[];
  /** Additional deny entries layered on top of `SHARED_DENY`. */
  extraDeny?: readonly string[];
  /**
   * Reader-only: deny bare `Edit`. Default `true`. Executors ignore this (they
   * allow Edit via the base set).
   */
  denyEdit?: boolean;
  /**
   * Reader-only: deny bare `Write`. Default `true`. The `plan` profile sets
   * this `false` so the path-scoped `Write(<staging>/**)` carve-out injected at
   * runtime by `buildOpsPlanClaudeRuntimeProfile` is not shadowed by a bare
   * `Write` deny (a strict allowlist already denies bare `Write` by omission).
   */
  denyWrite?: boolean;
  /**
   * Omit the own-namespace `Bash(prx <actor>:*)` glob. Default `false`. The
   * `submit` profile sets this `true`: it must NOT broaden to `Bash(prx
   * submit:*)` because that would re-admit `prx submit publish` (operator-only,
   * denied inside the session). It supplies verb-specific own-namespace grants
   * via `extraAllow` instead.
   */
  omitOwnNamespace?: boolean;
}

export interface ActorRuleset {
  allowedTools: string[];
  disallowedTools: string[];
}

function dedupe(entries: readonly string[]): string[] {
  return [...new Set(entries)];
}

/**
 * Build the `{ allowedTools, disallowedTools }` ruleset for an actor's session.
 *
 * Allow = base-for-role + `Bash(prx <actor>:*)` (own namespace) + extraAllow.
 * Deny  = SHARED_DENY + (reader: Edit/Write per the deny* flags) + extraDeny.
 *
 * Throws if `actor` is not a canonical actor name (typo fails loud).
 */
export function actorRuleset(actor: ActorName, options: ActorRulesetOptions = {}): ActorRuleset {
  if (!(actorNames as readonly string[]).includes(actor)) {
    throw new Error(
      `actorRuleset: '${actor}' is not a canonical actor (see src/machine/actor_names.ts)`,
    );
  }
  const role = options.role ?? "reader";
  const ownNamespace = options.omitOwnNamespace ? [] : [`Bash(prx ${actor}:*)`];

  const allowedTools = dedupe([
    ...BASE_TOOLS_BY_ROLE[role],
    ...ownNamespace,
    ...(options.extraAllow ?? []),
  ]);

  const roleDeny: string[] = [];
  if (role === "reader") {
    if (options.denyEdit ?? true) roleDeny.push("Edit");
    if (options.denyWrite ?? true) roleDeny.push("Write");
  }

  const disallowedTools = dedupe([...SHARED_DENY, ...roleDeny, ...(options.extraDeny ?? [])]);

  return { allowedTools, disallowedTools };
}
