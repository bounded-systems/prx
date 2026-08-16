import { join } from "node:path";
import {
  buildWorkUnitCopilotRuntimeProfile,
  buildWorkUnitCodexRuntimeProfile,
  buildWorkUnitCursorRuntimeProfile,
  buildWorkUnitGeminiRuntimeProfile,
  buildWorkUnitClaudeRuntimeProfile,
  workAgentImplementations,
  type WorkAgentImplementation,
  type RuntimeIoFormat,
  type RuntimeMode,
  type RuntimeProfileProjection,
} from "../machine/runtime_profiles.ts";
import { CliError } from "./cli-error.ts";

// Extracted from packages/prx/src/pr-state/cli.ts by scripts/codemod/extract-module.ts — part of the
// §4 decomposition of the pr-state/cli.ts monolith into focused modules.

const workAgentAliases = {
  "gh-copilot": "copilot",
} as const satisfies Record<string, WorkAgentImplementation>;

const executionWorkAgents = [
  "claude",
  "codex",
] as const satisfies readonly WorkAgentImplementation[];

export type ExecutionWorkAgent = (typeof executionWorkAgents)[number];

const executionWorkAgentSet = new Set<WorkAgentImplementation>(executionWorkAgents);

type ExecutionPolicy = {
  timeout_ms: number;
  max_retries: number;
  allowed_agents: readonly WorkAgentImplementation[];
  temperature?: number;
};

export const POLICY: ExecutionPolicy = {
  timeout_ms: 30000,
  max_retries: 1,
  allowed_agents: executionWorkAgents,
  temperature: 0,
};

export function interactiveTimeoutMs(
  format: "plain" | "json",
  timeoutMs: number,
): number | undefined {
  return format === "plain" ? undefined : timeoutMs;
}

function supportsExecutionWorkflowAgent(
  agent: WorkAgentImplementation,
): agent is ExecutionWorkAgent {
  return executionWorkAgentSet.has(agent);
}

export function ensureExecutionWorkflowAgent(
  agent: WorkAgentImplementation,
  flag = "--agent",
): ExecutionWorkAgent {
  if (supportsExecutionWorkflowAgent(agent)) {
    return agent;
  }
  throw new CliError(
    `Invalid value for ${flag}: ${agent}. Execution workflows currently support: ${POLICY.allowed_agents.join(", ")}.`,
  );
}

function formatWorkAgentAliasMappings(): string {
  return Object.entries(workAgentAliases)
    .map(([alias, target]) => `${alias} -> ${target}`)
    .join(", ");
}

function formatSupportedWorkAgents(): string {
  const aliases = formatWorkAgentAliasMappings();
  const base = workAgentImplementations.join(", ");
  return aliases ? `${base} (aliases: ${aliases})` : base;
}

export function validateWorkIoFormat(
  agent: WorkAgentImplementation,
  ioFormat: RuntimeIoFormat,
): RuntimeIoFormat {
  if (agent === "copilot" && ioFormat === "stream-json") {
    throw new CliError("--io-format stream-json is not supported with --agent copilot");
  }
  return ioFormat;
}

export function parseWorkAgentImplementation(value: string, flag: string): WorkAgentImplementation {
  const normalized = workAgentAliases[value as keyof typeof workAgentAliases] ?? value;
  if (workAgentImplementations.includes(normalized as WorkAgentImplementation)) {
    return normalized as WorkAgentImplementation;
  }
  throw new CliError(
    `Invalid value for ${flag}: ${value}. Valid options: ${formatSupportedWorkAgents()}`,
  );
}

export function buildWorkAutomationProfile(
  agent: WorkAgentImplementation,
  workUnitId: string,
  ioFormat: RuntimeIoFormat,
  mode: RuntimeMode,
): RuntimeProfileProjection {
  if (agent === "codex") {
    return buildWorkUnitCodexRuntimeProfile({
      workUnitId,
      ioFormat,
      mode,
    });
  }
  if (agent === "copilot") {
    return buildWorkUnitCopilotRuntimeProfile({
      workUnitId,
      ioFormat,
      mode,
    });
  }
  if (agent === "gemini") {
    return buildWorkUnitGeminiRuntimeProfile({
      workUnitId,
      ioFormat,
      mode,
    });
  }
  if (agent === "cursor") {
    return buildWorkUnitCursorRuntimeProfile({
      workUnitId,
      ioFormat,
      mode,
    });
  }
  return buildWorkUnitClaudeRuntimeProfile({
    agentId: workUnitId,
    workUnitId,
    ioFormat,
    mode,
  });
}
