// prx-wt5 — `prx mediator <verb>` CLI contract (design pass).
//
// The declarative source of truth for the mediator namespace, mirroring the
// dolt schema (GH-2129). v0 ships three read-only verbs — `detect`, `classify`,
// `status` — that write NOTHING to the working tree (I-MED1). Their
// implementation (the detector orchestrator that reads live `git rebase`/
// `merge` state and emits the `mediatorMachine` events) is deferred to a child
// ticket, so every verb currently routes to `mediator-stub`, which emits a
// typed `not-implemented` outcome naming the tracking unit. Wiring a verb later
// is a one-row change here: flip its `route` from "mediator-stub" to the real
// command name; the dispatcher, error strings, and parity tests all derive
// from this table.

import { z } from "zod";

export const MEDIATOR_VERBS = ["detect", "classify", "status"] as const;
export type MediatorVerb = (typeof MEDIATOR_VERBS)[number];

// Shared shape: every verb is scoped to a repo working copy and chooses an
// output format. Read-only — no `--apply` / no working-tree mutation (I-MED1).
const RepoScopedInput = z.object({
  repoPath: z.string().default("."),
  format: z.enum(["plain", "json"]).default("plain"),
});

export const DetectInput = RepoScopedInput;
export type DetectInput = z.infer<typeof DetectInput>;
export const ClassifyInput = RepoScopedInput;
export type ClassifyInput = z.infer<typeof ClassifyInput>;
export const StatusInput = RepoScopedInput;
export type StatusInput = z.infer<typeof StatusInput>;

export const MEDIATOR_INPUT_SCHEMAS = {
  detect: DetectInput,
  classify: ClassifyInput,
  status: StatusInput,
} as const satisfies Record<MediatorVerb, z.ZodTypeAny>;

// A tracking id is a GitHub issue (GH-1234) or a bd unit (prx-abc) — the
// mediator's child tickets are bd-only, so the stub references those directly.
const trackingId = z.string().regex(/^(GH-\d+|[a-z][a-z0-9]*-[a-z0-9]+)$/);

// Typed outcome for an unwired mediator verb. The stub handler emits this shape
// (plain text by default, JSON under `--format=json`) and exits non-zero so a
// caller can tell "not yet implemented" from a real failure.
export const MediatorStubOutput = z.object({
  verb: z.enum(MEDIATOR_VERBS),
  status: z.literal("not-implemented"),
  tracking: trackingId,
  message: z.string(),
});
export type MediatorStubOutput = z.infer<typeof MediatorStubOutput>;

// The single declarative source of truth for the `prx mediator <verb>` CLI
// surface. Each verb names (1) the dispatcher route the namespace rewrite
// rewrites to, and (2) the tracking unit that owns its implementation. Today
// all three route to `mediator-stub`; the detector orchestrator that wires
// them lands under the prx-wt5 epic.
export const MEDIATOR_VERB_DISPATCH = {
  detect: { route: "mediator-stub", tracking: "prx-wt5" },
  classify: { route: "mediator-stub", tracking: "prx-wt5" },
  status: { route: "mediator-stub", tracking: "prx-wt5" },
} as const satisfies Record<MediatorVerb, { route: string; tracking: string }>;
