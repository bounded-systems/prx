// GH-1821 — pure-function guards referenced by TransitionContract.guardId.
//
// A guard takes an artifact graph stub (`type → { status, ... }`) and returns
// `{ ok: true }` or `{ ok: false, reason }`. The trinity intentionally keeps
// guards as plain functions invoked by tests / the CLI rather than wiring
// them into the live `workflowBackbone` XState graph — the documentary state
// remains untouched (per the GH-1821 scope).

import {
  type ArtifactGraph,
  artifactGraphSchema,
  type GuardVerdict,
  type TransitionContract,
} from "../contracts.ts";
import {
  assertInvariants,
  rawStateV1Schema,
  type RawStateV1,
} from "@bounded-systems/machine-schema";

export type GuardFn = (input: {
  graph: ArtifactGraph;
  contract: TransitionContract;
}) => GuardVerdict;

// ── role axis: testing → reviewing ────────────────────────────────────────
//
// Required artifact: `test_run` with status="passed".
// Forbidden artifact: `blocker_report` must not be present.

const testToReview: GuardFn = ({ graph, contract }) => {
  const parsed = artifactGraphSchema.parse(graph);
  const testRun = parsed[contract.requiredArtifact];
  if (!testRun) {
    return {
      ok: false,
      reason: `required artifact ${contract.requiredArtifact} missing from graph`,
    };
  }
  if (contract.requiredStatus === "passed" && testRun.status !== "passed") {
    return {
      ok: false,
      reason: `required artifact ${contract.requiredArtifact}.status=${
        testRun.status ?? "absent"
      }; need "passed"`,
    };
  }
  for (const forbidden of contract.forbiddenArtifacts) {
    const present = parsed[forbidden];
    if (present && present.status !== "absent") {
      return {
        ok: false,
        reason: `forbidden artifact ${forbidden} present in graph`,
      };
    }
  }
  return { ok: true };
};

// ── workflow axis: in_review → ready_to_merge ─────────────────────────────
//
// The contract requires a `raw_state_v1` artifact whose payload is a full
// RawStateV1 instance. Authorization delegates to the existing
// `assertInvariants(...)` I04 check (and the related signal predicates) so
// guard behavior is grounded in code that already ships.

const inReviewToReadyToMerge: GuardFn = ({ graph, contract }) => {
  const parsed = artifactGraphSchema.parse(graph);
  const raw = parsed[contract.requiredArtifact];
  if (!raw) {
    return {
      ok: false,
      reason: `required artifact ${contract.requiredArtifact} missing from graph`,
    };
  }
  if (raw.status !== "present" && raw.status !== "passed") {
    return {
      ok: false,
      reason: `required artifact ${contract.requiredArtifact}.status=${
        raw.status ?? "absent"
      }; need "present"`,
    };
  }
  const payload = (raw as { payload?: unknown }).payload;
  if (!payload) {
    return {
      ok: false,
      reason: `artifact ${contract.requiredArtifact} carries no payload; cannot evaluate I04`,
    };
  }
  let rawState: RawStateV1;
  try {
    rawState = rawStateV1Schema.parse(payload);
  } catch (err) {
    return {
      ok: false,
      reason: `raw_state_v1 payload failed schema validation: ${(err as Error).message}`,
    };
  }
  const report = assertInvariants(rawState, "ready_to_merge");
  if (!report.valid) {
    return {
      ok: false,
      reason: report.findings.map((f) => `${f.id}: ${f.message}`).join("; "),
    };
  }
  return { ok: true };
};

// ── lifecycle axis: map → delegate ────────────────────────────────────────
//
// Required artifact: `work_map` with status="present".
// Forbidden artifact: `blocker_report` (any present blocker halts delegation
// until the unblock_condition is met — the GH-1822 schema makes that field
// required, so the unblocking signal is itself typed).

const mapToDelegate: GuardFn = ({ graph, contract }) => {
  const parsed = artifactGraphSchema.parse(graph);
  const workMap = parsed[contract.requiredArtifact];
  if (!workMap) {
    return {
      ok: false,
      reason: `required artifact ${contract.requiredArtifact} missing from graph`,
    };
  }
  if (contract.requiredStatus === "present" && workMap.status !== "present") {
    return {
      ok: false,
      reason: `required artifact ${contract.requiredArtifact}.status=${
        workMap.status ?? "absent"
      }; need "present"`,
    };
  }
  for (const forbidden of contract.forbiddenArtifacts) {
    const present = parsed[forbidden];
    if (present && present.status !== "absent") {
      return {
        ok: false,
        reason: `forbidden artifact ${forbidden} present in graph`,
      };
    }
  }
  return { ok: true };
};

// ── lifecycle axis: delegate → execute ───────────────────────────────────
//
// Required artifact: `delegation_record` with status="present". The first
// cross-axis transition in the trinity — it authorizes the handoff from
// the lifecycle axis into the role axis (planning → executing → …).

const delegateToExecute: GuardFn = ({ graph, contract }) => {
  const parsed = artifactGraphSchema.parse(graph);
  const record = parsed[contract.requiredArtifact];
  if (!record) {
    return {
      ok: false,
      reason: `required artifact ${contract.requiredArtifact} missing from graph`,
    };
  }
  if (contract.requiredStatus === "present" && record.status !== "present") {
    return {
      ok: false,
      reason: `required artifact ${contract.requiredArtifact}.status=${
        record.status ?? "absent"
      }; need "present"`,
    };
  }
  for (const forbidden of contract.forbiddenArtifacts) {
    const present = parsed[forbidden];
    if (present && present.status !== "absent") {
      return {
        ok: false,
        reason: `forbidden artifact ${forbidden} present in graph`,
      };
    }
  }
  return { ok: true };
};

// ── registry ──────────────────────────────────────────────────────────────

export const guardRegistry: Readonly<Record<string, GuardFn>> = Object.freeze({
  "testToReview.requireTestRunPassed": testToReview,
  "inReviewToReadyToMerge.delegateI04": inReviewToReadyToMerge,
  "mapToDelegate.requireWorkMap": mapToDelegate,
  "delegateToExecute.requireDelegationRecord": delegateToExecute,
});

export function getGuard(id: string): GuardFn | undefined {
  return guardRegistry[id];
}

export function runGuard(input: {
  graph: ArtifactGraph;
  contract: TransitionContract;
}): GuardVerdict {
  const guard = guardRegistry[input.contract.guardId];
  if (!guard) {
    return {
      ok: false,
      reason: `unknown guardId: ${input.contract.guardId}`,
    };
  }
  return guard(input);
}
