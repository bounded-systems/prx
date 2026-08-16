// ai-home-mqlno — verb-level capabilities (envelope-first).
//
// The dispatch gate is ACTOR-level today (target.allowedCallers), so admitting
// `author` to the `publisher` forge grants ALL publisher verbs — including
// `merge`. That's too coarse: author should reach pr open/comment/edit + ready/
// draft but never `merge`. Capabilities are the fix: a verb *requires* authority
// tokens; a caller *holds* granted tokens; dispatch is admitted only when the
// caller holds every required token (in addition to the actor-level gate).
//
// Envelope-first: this is the contract + the subset check. Wiring required-caps
// onto verbs, granted-caps onto callers, and the check into `canDispatch` is the
// later runtime-conformance slice. Mock-tested here.

import { z } from "zod";

/**
 * Authority classes a verb may require. Coarse on purpose — these are the
 * blast-radius boundaries (mutate the forge / git / beads / publish), not
 * per-verb names. Extend as new authority classes appear.
 */
export const Capability = z.enum([
  "pr-write", // open/edit/comment/ready/draft a PR (the forge author surface)
  "merge", // enable automerge / merge a PR — strictly gated
  "git-write", // push / branch / commit (keeper)
  "bd-write", // mutate beads records
  "publish", // cut a release / publish artifacts to a mirror
]);
export type Capability = z.infer<typeof Capability>;

export const ALL_CAPABILITIES: readonly Capability[] = Capability.options;

/** Capabilities a verb requires to run (empty ⇒ no special authority needed). */
export const RequiredCapabilities = z.array(Capability).default([]);
export type RequiredCapabilities = z.infer<typeof RequiredCapabilities>;

/**
 * True when `granted` holds EVERY capability in `required` — the verb-level
 * gate. A caller missing any required cap is denied even if the actor-level
 * `allowedCallers` admits it (e.g. author dispatching `publisher merge`).
 */
export function callerHoldsCapabilities(
  required: readonly Capability[],
  granted: readonly Capability[],
): boolean {
  const held = new Set<Capability>(granted);
  return required.every((cap) => held.has(cap));
}

/** The required caps a caller is missing (for a deny reason). */
export function missingCapabilities(
  required: readonly Capability[],
  granted: readonly Capability[],
): Capability[] {
  const held = new Set<Capability>(granted);
  return required.filter((cap) => !held.has(cap));
}
