// prx command registry — Zod-first source of truth (GH-975, parent epic GH-974).
//
// PR-1 of GH-1242: extends `CommandSpec` with `actor`, `event`, and `args`
// fields the actor-action dispatcher (PR-3+) consumes, and introduces the
// sibling `ActorSpec` schema PR-2 will populate. This file owns the schemas
// and types only — entries + lookup helpers live in `./registry.data.ts` so
// the schema module has no dependency on the entry table (avoids ESM cycles
// caused by data.ts's top-level `CommandSpec.parse(RAW_REGISTRY)`).
//
// `formatHelp()` and `formatFullCommandCatalogHelp()` in `cli.ts` re-encode
// command facts as string templates; this registry lifts those facts into a
// typed schema. The renderer (#976), session-entry XState machine (#977), and
// root-oddity audit (#978) all consume this module. cli.ts dispatch is not
// touched by GH-975 / PR-1 — only the data layer.
//
// IA invariants encoded as Zod refinements + registry-level tests
// (see `docs/prx/help-surface.md`):
//
//   §6.4  description is 4-12 words                — Zod refine on `description`
//   §6.2  ≤6 promoted entries per session context  — registry-level test
//   §4    verb-object: `prx <profile> session`     — registry-level test
//   §3/§8 deprecation alias requires stderr hint   — Zod required `min(1)`

import { z } from "zod";
import { actorNames } from "../machine/actor_names.ts";
import { sessionProfileNames } from "../machine/runtime_profiles.ts";

export const SessionContext = z.enum([
  "mainx",
  "plan",
  "intake",
  "triage",
  "implement",
  "submit",
  "author",
  "scratch",
]);
export type SessionContext = z.infer<typeof SessionContext>;

export const CommandDomain = z.enum(["state", "work-units", "repo-plumbing", "system"]);
export type CommandDomain = z.infer<typeof CommandDomain>;

export const Deprecation = z.object({
  alias_for: z.string().min(1),
  removal_target: z.string().min(1),
  stderr_hint: z.string().min(1),
});
export type Deprecation = z.infer<typeof Deprecation>;

// Canonical actors (GH-1242). Single source of truth for the `actor` field on
// both `CommandSpec` and `ActorSpec`. GH-1530 lifted the actor-name tuple into
// the `src/machine/actor_names.ts` leaf so the CLI registry, the dispatch
// taxonomy (`dispatchActors`), and the per-actor permission helper
// (`actorRuleset`) all enumerate the same vocabulary without forming an ESM
// import cycle. The per-actor rationale comments now live in that leaf.
export const ActorName = z.enum(actorNames);
export type ActorName = z.infer<typeof ActorName>;

// GH-1311: subdivides actor-scoped children into lifecycle (boots/closes the
// session pane), toolset (called from inside an open session), and preflight
// (introspection/validation hybrids). Help renderer (PR-3) groups by this.
export const SessionRole = z.enum(["lifecycle", "toolset", "preflight"]);
export type SessionRole = z.infer<typeof SessionRole>;

const wordCount4to12 = (value: string): boolean => {
  const n = value
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
  return n >= 4 && n <= 12;
};

export const CommandSpec = z.object({
  name: z.string().min(1),
  parent: z.string().min(1).optional(),
  description: z.string().refine(wordCount4to12, {
    message: "description must be 4-12 words (help-surface §6.4)",
  }),
  domain: CommandDomain,
  promoted_in: z.array(SessionContext).default([]),
  binding: z.enum(["work-unit", "mainx", "none"]).default("none"),
  session_profile: z.enum(sessionProfileNames).optional(),
  session_role: SessionRole.optional(),
  deprecation: Deprecation.optional(),
  internal: z.boolean().default(false),
  // GH-1242 PR-1 substrate (no dispatcher behavior change in PR-1):
  //   actor — the canonical actor that owns this entry. Required;
  //           deterministically backfilled from `parent` for namespaced
  //           entries and from the GH-1242 migration table for top-level
  //           entries. PR-3 dispatcher reads this to route the parsed
  //           command at `actor.send()`.
  //   event — typed event name the eventual machine-per-actor will receive
  //           (SCREAMING_SNAKE per `src/triage/schemas/events.ts`). Optional
  //           in PR-1; PR-3+ populates and may tighten to a per-actor enum.
  //   args  — Zod schema the parser will use to validate argv → typed input
  //           before constructing the event. Optional in PR-1; PR-3+
  //           populates.
  actor: ActorName,
  event: z.string().min(1).optional(),
  args: z.instanceof(z.ZodType).optional(),
});
export type CommandSpec = z.infer<typeof CommandSpec>;

// Sibling actor registry schema (GH-1242 PR-1 substrate). PR-2 lands the help
// actor and starts populating an actor registry; PR-1 ships the type only so
// the actor field on `CommandSpec` and the upcoming actor entries share one
// `ActorName` enum.
export const ActorSpec = z.object({
  name: ActorName,
  summary: z.string().optional(),
  default_action: z.string().optional(),
  // GH-1530 (object-capability redesign): inbound dispatch capability. The
  // TARGET actor declares who may dispatch to it — the ocap flip from the
  // GH-1194 caller-authoritative `allowedDispatchTargets` (outbound, on the
  // session profile) to a target-owned inbound list. `canDispatch` consumes
  // `allowedCallers` via dependency injection (the handler resolves
  // `actorSpecFor(target).allowedCallers`), mirroring how it already injects
  // the caller-side `allowedTargets`.
  //   dispatchable  — may this actor be dispatched TO at all? A terminal /
  //                   non-dispatchable actor stays `false` and rejects every
  //                   caller regardless of `allowedCallers`.
  //   allowedCallers — the source actors permitted to dispatch to this
  //                   target. Empty ⇒ no caller is admitted (deny-by-default).
  dispatchable: z.boolean().default(false),
  allowedCallers: z.array(ActorName).default([]),
});
export type ActorSpec = z.infer<typeof ActorSpec>;
