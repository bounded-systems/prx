// GH-2438 / ai-home-mqlno — the effect-typed verb model as enforceable Zod.
//
// The TypeScript boundary form of `spec/prx/schema.cue` (#Surface, #Verb.reads/
// writes). Envelope-first: this is the contract; conforming `CommandSpec` to
// carry per-verb effects (and the `cue vet`/registry sweep) is the later slice.
//
// The load-bearing rule is **Rule 4 — one write surface per verb**: `writes` is
// a single Surface or null, so two-surface mutation is structurally
// unrepresentable. A verb that needs to touch two surfaces (the mirror/reconcile
// family — `submit publish`, `delegate assign`) must split into a canonical
// write + a single-surface projection.

import { z } from "zod";

/**
 * The backing stores a verb may touch. A surface is a STORE, not an actor
 * (Rule 3: `github` is a surface, never an actor). Mirrors `#Surface` in
 * spec/prx/schema.cue.
 */
export const Surface = z.enum(["github", "dolt", "notion", "filesystem", "cas", "tmux"]);
export type Surface = z.infer<typeof Surface>;

export const ALL_SURFACES: readonly Surface[] = Surface.options;

/**
 * A verb's effects. `reads` is unbounded; `writes` is AT MOST ONE surface
 * (Rule 4) — `Surface | null`, never a set. Defaults make effects optional/
 * additive so they can be layered onto existing specs without churn.
 */
export const VerbEffects = z.object({
  reads: z.array(Surface).default([]),
  /** The single surface this verb mutates, or null for a pure read. */
  writes: Surface.nullable().default(null),
});
export type VerbEffects = z.infer<typeof VerbEffects>;

/** A pure-read verb writes nothing. */
export function isReadOnly(effects: VerbEffects): boolean {
  return effects.writes === null;
}

/**
 * The set of distinct surfaces a verb touches (reads ∪ writes). A verb that
 * *reads* many surfaces but *writes* one is Rule-4-compliant; this is for
 * provenance/inspection, not the rule (the schema already enforces the rule).
 */
export function touchedSurfaces(effects: VerbEffects): Surface[] {
  const set = new Set<Surface>(effects.reads);
  if (effects.writes !== null) set.add(effects.writes);
  return [...set];
}
