import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

import type { UnitOfWorkSurface, UnitOfWorkSurfaceRow } from "./uow.ts";

const canonicalIdSchema = z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/);

const personalSprintxSchema = z.object({
  sprintId: z.string().min(1),
  owner: z.string().min(1),
  weeklyGoal: z.object({
    outcome: z.string().min(1),
    metric: z.string().min(1),
    targetDelta: z.number(),
    assignedUowIds: z.array(canonicalIdSchema).min(1),
  }).strict(),
  sprintGoal: z.object({
    outcome: z.string().min(1),
    metric: z.string().min(1),
  }).strict(),
  metric: z.object({
    baseline: z.number().nullable(),
    current: z.number().nullable(),
  }).strict(),
  bindings: z.record(
    canonicalIdSchema,
    z.object({
      metric: z.string().min(1),
      expectedDelta: z.number().nullable().optional(),
    }).strict(),
  ),
  velocity: z.object({
    pointsCompleted: z.number().nonnegative().nullable().optional(),
  }).strict().optional(),
}).strict();

export type PersonalSprintxConfig = z.infer<typeof personalSprintxSchema>;

export type PersonalSprintxDerived = {
  sprintId: string;
  owner: string;
  weeklyGoal: {
    outcome: string;
    metric: string;
    targetDelta: number;
  };
  sprintGoal: {
    outcome: string;
    metric: string;
  };
  assigned: {
    total: number;
    contributing: number;
    merged: number;
    blocked: number;
    running: number;
  };
  metric: {
    baseline: number | null;
    current: number | null;
    deltaPercent: number | null;
    targetDelta: number;
    progressPercent: number | null;
    metTarget: boolean;
    status: "met_target" | "on_track" | "at_risk" | "failed_target";
  };
  velocity: {
    pointsCompleted: number | null;
    mergedUnits: number;
  };
  goalRows: Array<{
    id: string;
    board: UnitOfWorkSurfaceRow["board"];
    prNumber: number | null;
    contribution: "contributing" | "non-goal";
  }>;
};

function normalizeId(id: string): string {
  return id.trim().toUpperCase();
}

function parseConfig(raw: string): PersonalSprintxConfig {
  const parsed = personalSprintxSchema.parse(JSON.parse(raw));
  return {
    ...parsed,
    weeklyGoal: {
      ...parsed.weeklyGoal,
      assignedUowIds: parsed.weeklyGoal.assignedUowIds.map(normalizeId),
    },
    bindings: Object.fromEntries(
      Object.entries(parsed.bindings).map(([id, binding]) => [normalizeId(id), binding]),
    ),
  };
}

export function loadPersonalSprintxConfig(path: string): PersonalSprintxConfig | null {
  if (!path || !existsSync(path)) return null;
  try {
    return parseConfig(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function isMergedLike(board: UnitOfWorkSurfaceRow["board"]): boolean {
  return board === "merged" || board === "cleaned" || board === "merge_ready";
}

function isBlockedLike(board: UnitOfWorkSurfaceRow["board"]): boolean {
  return board === "changes_requested" || board === "no_worktree" || board === "worktree_created";
}

function metricStatus(
  baseline: number | null,
  current: number | null,
  targetDelta: number,
): PersonalSprintxDerived["metric"] {
  if (baseline === null || current === null || baseline === 0) {
    return {
      baseline,
      current,
      deltaPercent: null,
      targetDelta,
      progressPercent: null,
      metTarget: false,
      status: "at_risk",
    };
  }

  const deltaPercent = ((current - baseline) / baseline) * 100;
  const metTarget = targetDelta >= 0 ? deltaPercent >= targetDelta : deltaPercent <= targetDelta;
  const progressPercent = targetDelta === 0
    ? null
    : Math.min(100, Math.max(0, (Math.abs(deltaPercent) / Math.abs(targetDelta)) * 100));

  const movedWrongDirection = targetDelta >= 0 ? deltaPercent < 0 : deltaPercent > 0;
  const status = metTarget ? "met_target" : movedWrongDirection ? "failed_target" : "on_track";

  return {
    baseline,
    current,
    deltaPercent,
    targetDelta,
    progressPercent,
    metTarget,
    status,
  };
}

export function derivePersonalSprintx(
  surface: UnitOfWorkSurface,
  config: PersonalSprintxConfig,
): PersonalSprintxDerived {
  const assignedSet = new Set(config.weeklyGoal.assignedUowIds.map(normalizeId));
  const assignedRows = surface.rows.filter((row) => assignedSet.has(normalizeId(row.id)));
  const contributingRows = assignedRows.filter((row) => {
    const binding = config.bindings[normalizeId(row.id)];
    return Boolean(binding && binding.metric === config.weeklyGoal.metric);
  });
  const merged = assignedRows.filter((row) => isMergedLike(row.board)).length;
  const blocked = assignedRows.filter((row) => isBlockedLike(row.board)).length;
  const running = assignedRows.filter((row) => row.agent.state === "running").length;
  const metric = metricStatus(config.metric.baseline, config.metric.current, config.weeklyGoal.targetDelta);

  return {
    sprintId: config.sprintId,
    owner: config.owner,
    weeklyGoal: {
      outcome: config.weeklyGoal.outcome,
      metric: config.weeklyGoal.metric,
      targetDelta: config.weeklyGoal.targetDelta,
    },
    sprintGoal: config.sprintGoal,
    assigned: {
      total: assignedRows.length,
      contributing: contributingRows.length,
      merged,
      blocked,
      running,
    },
    metric,
    velocity: {
      pointsCompleted: config.velocity?.pointsCompleted ?? null,
      mergedUnits: merged,
    },
    goalRows: assignedRows.map((row) => ({
      id: row.id,
      board: row.board,
      prNumber: row.prNumber,
      contribution: config.bindings[normalizeId(row.id)]?.metric === config.weeklyGoal.metric
        ? "contributing"
        : "non-goal",
    })),
  };
}
