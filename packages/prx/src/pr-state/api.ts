import type { RuntimeIoFormat, RuntimeMode } from "../machine/runtime_profiles.ts";
import { canonicalWorkUnitIdPattern } from "../machine/work_unit.ts";
import {
  hydrateUnitOfWorkSurface,
  type UnitOfWorkSurface,
  type UnitOfWorkSurfaceRow,
} from "./uow.ts";
import type { ClaudeRunResult } from "./tui.ts";

export type PrxControlState = "idle" | "dispatching" | "done" | "failed";
export type PrxUnitState = UnitOfWorkSurfaceRow["board"] | "unmapped";
export type PrxAgentState = UnitOfWorkSurfaceRow["agent"]["state"];

export type PrxApiContext = {
  repoPath: string;
  ticketPath: string;
  workUnitId: string;
  agentId: string;
  mode: RuntimeMode;
  ioFormat: RuntimeIoFormat;
  controlState: PrxControlState;
  result: ClaudeRunResult | null;
  lastError: string | null;
};

export type PrxApiSnapshot = {
  selection: {
    workUnitId: string;
    agentId: string;
    mode: RuntimeMode;
    ioFormat: RuntimeIoFormat;
  };
  controlState: PrxControlState;
  unitState: PrxUnitState;
  agentState: PrxAgentState;
  mapping: "strict-1:1" | "invalid";
  canRun: boolean;
  runBlockers: string[];
  surface: UnitOfWorkSurface | null;
  surfaceError: string | null;
  activeRow: UnitOfWorkSurfaceRow | null;
  result: ClaudeRunResult | null;
  lastError: string | null;
};

type SurfaceHydrator = typeof hydrateUnitOfWorkSurface;

function controlToSurfaceState(
  controlState: PrxControlState,
): UnitOfWorkSurfaceRow["agent"]["state"] {
  switch (controlState) {
    case "dispatching":
      return "running";
    case "done":
      return "done";
    case "failed":
      return "error";
    case "idle":
    default:
      return "idle";
  }
}

function isCanonicalWorkUnitId(value: string): boolean {
  return canonicalWorkUnitIdPattern.test(value);
}

export function getPrxSnapshot(
  context: PrxApiContext,
  hydrateSurface: SurfaceHydrator = hydrateUnitOfWorkSurface,
): PrxApiSnapshot {
  const runBlockers: string[] = [];
  const mapping = context.agentId === context.workUnitId ? "strict-1:1" : "invalid";
  let surface: UnitOfWorkSurface | null = null;
  let surfaceError: string | null = null;

  if (!isCanonicalWorkUnitId(context.workUnitId)) {
    runBlockers.push("no canonical work unit selected");
  }

  if (mapping !== "strict-1:1") {
    runBlockers.push("agent/work-unit mapping is not strict 1:1");
  }

  try {
    surface = hydrateSurface(context.repoPath, {
      activeWorkUnitId: context.workUnitId,
      activeAgentId: context.agentId,
      activeState: controlToSurfaceState(context.controlState),
      ticketPath: context.ticketPath,
    });
  } catch (error) {
    surfaceError = error instanceof Error ? error.message : String(error);
    runBlockers.push(`surface unavailable: ${surfaceError}`);
  }

  const activeRow = surface?.rows.find((row) => row.id === context.workUnitId) ?? null;
  if (surface && !activeRow) {
    runBlockers.push(`no unit of work found for ${context.workUnitId}`);
  }

  return {
    selection: {
      workUnitId: context.workUnitId,
      agentId: context.agentId,
      mode: context.mode,
      ioFormat: context.ioFormat,
    },
    controlState: context.controlState,
    unitState: activeRow?.board ?? "unmapped",
    agentState: activeRow?.agent.state ?? "idle",
    mapping,
    canRun: runBlockers.length === 0,
    runBlockers,
    surface,
    surfaceError,
    activeRow,
    result: context.result,
    lastError: context.lastError,
  };
}
