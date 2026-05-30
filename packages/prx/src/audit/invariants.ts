// GH-1823 — five runnable invariant predicates that back I-AUD1..I-AUD5.
//
// Each predicate takes typed inputs and returns an `InvariantFinding[]`. The
// ingester (`src/audit/store/ingest.ts`) runs them per UoW after upserting
// `uow_artifacts` rows; findings land in `invariant_findings` and feed the
// `prx audit uow` projection.
//
// The predicates intentionally stay narrow: they do NOT decide derived
// phase, do NOT mutate state, do NOT decide whether a UoW is "done". Each
// answers one specific question whose violation is a hard-fail per
// GH-1824's architectural promise.

import type { InvariantFinding } from "@bounded-systems/machine-schema";
import {
  artifactTypeMeta,
  requiredArtifactTypesForPhase,
  type ArtifactSlot,
} from "./artifact-types.ts";

// Re-export so single-import sites don't need to reach into machine/state.
export type { InvariantFinding } from "@bounded-systems/machine-schema";

export type AuditEvent = {
  ts: string;
  uow_id: string | null;
  actor: string;
  action: string;
  artifact_type?: string | null;
};

export type DerivedUowStatus = {
  uow_id: string;
  recorded_status: string | null;
  derived_phase: string;
};

export type GuardedTransition = {
  uow_id: string;
  state_from: string;
  state_to: string;
  // The set of artifact types whose `status === "present" | "passed"` at the
  // moment the transition fired (snapshotted from `uow_artifacts`).
  present_artifact_types: readonly string[];
};

const hard = (id: string, message: string): InvariantFinding => ({
  id,
  severity: "hard",
  message,
});

// I-AUD1: every event has a `uow_id` (or aggregate-uow ref).
//
// The legacy NDJSON sink predates the UoW concept and uses an `issue` field
// for GH-rooted units (see `src/pr-state/transition_log.ts`). The ingester
// maps that field to `uow_id` at read time, so by the time events reach this
// predicate the UoW id is either `null` or present.
export function assertUowAttachment(events: readonly AuditEvent[]): InvariantFinding[] {
  const findings: InvariantFinding[] = [];
  for (const ev of events) {
    if (ev.uow_id === null) {
      findings.push(
        hard(
          "I-AUD1",
          `audit event lacks uow_id (actor=${ev.actor}, action=${ev.action}, ts=${ev.ts})`,
        ),
      );
    }
  }
  return findings;
}

// I-AUD2: every artifact carries `uow_id` and `input_refs[]` (lineage).
//
// The lineage check skips artifact types whose metadata declares
// `lineage_required: false` — `status_update`, `work_map`, etc. legitimately
// have no upstream artifact to point at.
export function assertArtifactLineage(slots: readonly ArtifactSlot[]): InvariantFinding[] {
  const findings: InvariantFinding[] = [];
  for (const slot of slots) {
    if (slot.status === "absent") continue;
    const meta = artifactTypeMeta[slot.type];
    if (meta.owning_uow_required && slot.uow_id.length === 0) {
      findings.push(
        hard(
          "I-AUD2",
          `artifact ${slot.type} (ref=${slot.ref ?? "<no-ref>"}) has no uow_id`,
        ),
      );
    }
    if (meta.lineage_required && slot.input_refs.length === 0) {
      findings.push(
        hard(
          "I-AUD2",
          `artifact ${slot.type} (uow=${slot.uow_id}, ref=${slot.ref ?? "<no-ref>"}) has empty input_refs[]`,
        ),
      );
    }
  }
  return findings;
}

// I-AUD3: every phase transition is guarded by the required artifacts per
// TransitionContract (GH-1821). For each transition, the required-for-phase
// set of the *destination* phase must be a subset of the artifact types
// whose status was `present` (or stronger) at the transition moment.
export function assertGuardedTransition(
  transition: GuardedTransition,
): InvariantFinding[] {
  const required = requiredArtifactTypesForPhase(
    transition.state_to as Parameters<typeof requiredArtifactTypesForPhase>[0],
  );
  // If `state_to` is not in the canonical phase list, the predicate is a
  // no-op (the transition is in a non-workflow region — review, ci, etc.).
  if (required.length === 0) return [];
  const present = new Set(transition.present_artifact_types);
  const missing = required.filter((t) => !present.has(t));
  if (missing.length === 0) return [];
  return [
    hard(
      "I-AUD3",
      `unguarded transition for uow=${transition.uow_id}: ${transition.state_from} → ${transition.state_to} missing required artifacts [${missing.join(", ")}]`,
    ),
  ];
}

// I-AUD4: every Git mutation goes through PRX — agent sessions emit zero
// ambient-git violations.
//
// Heuristic: an event whose actor is an agent variant
// (`claude-code`, `codex`, `gemini-cli`, `agent.*`) and whose `action`
// matches a known git-mutation verb counts as an ambient-git violation.
// The PRX wrappers (`prx tools git ...`) re-emit events with `actor: "git"`
// so they pass the check.
const AGENT_ACTORS = new Set<string>([
  "claude-code",
  "codex",
  "gemini-cli",
  "agent.executor",
  "agent.planner",
  "agent.tester",
  "agent.reviewer",
]);

const AMBIENT_GIT_ACTIONS = new Set<string>([
  "git push",
  "git push --force",
  "git push --force-with-lease",
  "git commit",
  "git commit -a",
  "git rebase",
  "git reset --hard",
  "git checkout --",
  "git restore .",
  "git clean -f",
  "git branch -D",
]);

export function assertNoAmbientGit(events: readonly AuditEvent[]): InvariantFinding[] {
  const findings: InvariantFinding[] = [];
  for (const ev of events) {
    if (!AGENT_ACTORS.has(ev.actor)) continue;
    if (!AMBIENT_GIT_ACTIONS.has(ev.action)) continue;
    findings.push(
      hard(
        "I-AUD4",
        `ambient git mutation by agent: actor=${ev.actor} action=${ev.action} ts=${ev.ts}${ev.uow_id ? ` uow=${ev.uow_id}` : ""}`,
      ),
    );
  }
  return findings;
}

// I-AUD5: every UoW status is derived from the artifact graph, not stored
// as a free field. The ingester computes `derived_phase` from the artifact
// chain and compares it against the recorded status (e.g. bd's `status`
// column or the transition log's most-recent `state_to`). A mismatch means
// status is being written ad hoc rather than derived.
export function assertDerivedStatus(uow: DerivedUowStatus): InvariantFinding[] {
  if (uow.recorded_status === null) return [];
  if (uow.recorded_status === uow.derived_phase) return [];
  return [
    hard(
      "I-AUD5",
      `uow=${uow.uow_id} recorded status '${uow.recorded_status}' diverges from derived phase '${uow.derived_phase}'`,
    ),
  ];
}
