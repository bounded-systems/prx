import { z } from "zod";
import { canonicalWorkUnitIdSchema } from "./work_unit.ts";

export const outcomeStatuses = ["on_track", "at_risk", "failed_target", "met_target"] as const;
export type OutcomeStatus = (typeof outcomeStatuses)[number];

export const sprintStatuses = [
  "planning",
  "executing",
  "blocked",
  "outcome_failed",
  "complete",
] as const;
export type SprintStatus = (typeof sprintStatuses)[number];

export type SprintPrSnapshot = {
  number: number;
  state: "open" | "closed" | "merged" | "none";
  draft: boolean;
  checks: "green" | "pending" | "red" | "unknown";
  review: "approved" | "changes_requested" | "review_required" | "commented" | "unknown";
  mergeable: "mergeable" | "conflicting" | "unknown";
};

const sprintPrSnapshotSchema = z
  .object({
    number: z.number().int().positive(),
    state: z.enum(["open", "closed", "merged", "none"]),
    draft: z.boolean(),
    checks: z.enum(["green", "pending", "red", "unknown"]),
    review: z.enum(["approved", "changes_requested", "review_required", "commented", "unknown"]),
    mergeable: z.enum(["mergeable", "conflicting", "unknown"]),
  })
  .strict();

const rfc3339UtcString = z.string().datetime({ offset: true });
const ymdDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const sprintStateV1Schema = z
  .object({
    sprintId: z.string().min(1),
    week: z
      .object({
        startDate: ymdDateString,
        endDate: ymdDateString,
      })
      .strict(),
    goal: z
      .object({
        summary: z.string().min(1),
        metricName: z.string().min(1),
        targetDelta: z.number(),
      })
      .strict(),
    metric: z
      .object({
        baseline: z.number().nullable(),
        current: z.number().nullable(),
        status: z.enum(outcomeStatuses),
      })
      .strict(),
    bindings: z
      .object({
        prNumbers: z.array(z.number().int().positive()),
        ticketIds: z.array(canonicalWorkUnitIdSchema),
        unitIds: z.array(canonicalWorkUnitIdSchema),
      })
      .strict(),
    derived: z
      .object({
        executionProgress: z
          .object({
            total: z.number().int().min(0),
            merged: z.number().int().min(0),
            ready: z.number().int().min(0),
            blocked: z.number().int().min(0),
            inProgress: z.number().int().min(0),
            completion: z.number().min(0).max(1),
          })
          .strict(),
        outcomeStatus: z.enum(outcomeStatuses),
        sprintStatus: z.enum(sprintStatuses),
      })
      .strict(),
    meta: z
      .object({
        updatedAt: rfc3339UtcString,
      })
      .strict(),
  })
  .strict();

export type SprintStateV1 = z.infer<typeof sprintStateV1Schema>;

export type SprintInvariantFinding = {
  id: string;
  severity: "hard";
  message: string;
};

export type SprintInvariantReport = {
  valid: boolean;
  findings: SprintInvariantFinding[];
};

function uniqNumbers(values: number[]): number[] {
  return [...new Set(values)];
}

function uniqStrings(values: string[]): string[] {
  return [...new Set(values)];
}

export function deriveExecutionProgress(prSnapshots: SprintPrSnapshot[]) {
  const rows = z.array(sprintPrSnapshotSchema).parse(prSnapshots);
  let merged = 0;
  let ready = 0;
  let blocked = 0;
  let inProgress = 0;

  for (const row of rows) {
    if (row.state === "merged") {
      merged += 1;
      continue;
    }

    const readyToMerge =
      row.state === "open" &&
      !row.draft &&
      row.review === "approved" &&
      row.checks === "green" &&
      row.mergeable === "mergeable";

    if (readyToMerge) {
      ready += 1;
      continue;
    }

    const isBlocked =
      row.state === "closed" ||
      row.review === "changes_requested" ||
      row.checks === "red" ||
      row.mergeable === "conflicting";

    if (isBlocked) {
      blocked += 1;
      continue;
    }

    inProgress += 1;
  }

  const total = rows.length;
  const completion = total === 0 ? 0 : merged / total;
  return { total, merged, ready, blocked, inProgress, completion };
}

export function deriveOutcomeStatus(metric: {
  baseline: number | null;
  current: number | null;
  targetDelta: number;
}): OutcomeStatus {
  if (metric.baseline === null || metric.current === null || metric.baseline === 0) {
    return "at_risk";
  }

  const deltaPercent = ((metric.current - metric.baseline) / metric.baseline) * 100;
  const meetsTarget =
    metric.targetDelta >= 0
      ? deltaPercent >= metric.targetDelta
      : deltaPercent <= metric.targetDelta;
  if (meetsTarget) {
    return "met_target";
  }

  const movedWrongDirection = metric.targetDelta >= 0 ? deltaPercent < 0 : deltaPercent > 0;
  if (movedWrongDirection) {
    return "failed_target";
  }

  return "on_track";
}

export function deriveSprintStatus(
  progress: {
    total: number;
    merged: number;
    blocked: number;
    inProgress: number;
  },
  outcome: OutcomeStatus,
): SprintStatus {
  if (outcome === "failed_target") {
    return "outcome_failed";
  }
  if (progress.total === 0) {
    return "planning";
  }
  if (progress.blocked > 0) {
    return "blocked";
  }
  if (progress.merged === progress.total && outcome === "met_target") {
    return "complete";
  }
  return "executing";
}

export function assertSprintInvariants(stateInput: SprintStateV1): SprintInvariantReport {
  const state = sprintStateV1Schema.parse(stateInput);
  const findings: SprintInvariantFinding[] = [];
  const hard = (id: string, condition: boolean, message: string) => {
    if (!condition) findings.push({ id, severity: "hard", message });
  };

  hard(
    "S01",
    state.bindings.prNumbers.length === uniqNumbers(state.bindings.prNumbers).length,
    "bound PR numbers must be unique",
  );
  hard(
    "S02",
    state.bindings.ticketIds.length === uniqStrings(state.bindings.ticketIds).length,
    "bound ticket IDs must be unique",
  );
  hard(
    "S03",
    state.bindings.unitIds.length === uniqStrings(state.bindings.unitIds).length,
    "bound unit IDs must be unique",
  );
  hard(
    "S04",
    state.metric.baseline === null || Number.isFinite(state.metric.baseline),
    "metric baseline must be finite when present",
  );
  hard(
    "S05",
    state.metric.current === null || Number.isFinite(state.metric.current),
    "metric current must be finite when present",
  );
  hard(
    "S06",
    state.derived.sprintStatus !== "complete" || state.derived.outcomeStatus === "met_target",
    "sprint complete requires outcome status met_target",
  );
  hard(
    "S07",
    state.bindings.prNumbers.length === 0 ||
      state.bindings.ticketIds.length > 0 ||
      state.bindings.unitIds.length > 0,
    "every bound PR must map to sprint goal via ticket or unit binding set",
  );

  return {
    valid: findings.length === 0,
    findings,
  };
}

export function refreshSprintDerived(
  stateInput: SprintStateV1,
  prSnapshots: SprintPrSnapshot[],
): SprintStateV1 {
  const state = sprintStateV1Schema.parse(stateInput);
  const progress = deriveExecutionProgress(prSnapshots);
  const outcomeStatus = deriveOutcomeStatus({
    baseline: state.metric.baseline,
    current: state.metric.current,
    targetDelta: state.goal.targetDelta,
  });
  const sprintStatus = deriveSprintStatus(progress, outcomeStatus);

  return sprintStateV1Schema.parse({
    ...state,
    metric: {
      ...state.metric,
      status: outcomeStatus,
    },
    derived: {
      executionProgress: progress,
      outcomeStatus,
      sprintStatus,
    },
    meta: {
      updatedAt: new Date().toISOString(),
    },
  });
}

export function createSprintState(input: {
  sprintId: string;
  week: { startDate: string; endDate: string };
  goal: { summary: string; metricName: string; targetDelta: number };
}): SprintStateV1 {
  return sprintStateV1Schema.parse({
    sprintId: input.sprintId,
    week: input.week,
    goal: input.goal,
    metric: {
      baseline: null,
      current: null,
      status: "at_risk",
    },
    bindings: {
      prNumbers: [],
      ticketIds: [],
      unitIds: [],
    },
    derived: {
      executionProgress: {
        total: 0,
        merged: 0,
        ready: 0,
        blocked: 0,
        inProgress: 0,
        completion: 0,
      },
      outcomeStatus: "at_risk",
      sprintStatus: "planning",
    },
    meta: {
      updatedAt: new Date().toISOString(),
    },
  });
}
