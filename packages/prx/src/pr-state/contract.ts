import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

import type { LifecycleState } from "./machine.ts";
import { isReadyState, lifecycleStates } from "./machine.ts";

const lifecycleStateSchema = z.enum(lifecycleStates);

const readySchema = z
  .object({
    value: z.boolean().optional(),
    reason: z.string().nullable().optional(),
    checked_by: z.string().nullable().optional(),
    notes: z.array(z.string()).optional(),
  })
  .passthrough();

const lifecycleSchema = z
  .object({
    state: lifecycleStateSchema.optional(),
    updated_by: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
    notes: z.array(z.string()).optional(),
  })
  .passthrough();

const prStateSchema = z
  .object({
    title: z.string().optional(),
    ready: readySchema.optional(),
    lifecycle: lifecycleSchema.optional(),
  })
  .passthrough();

const contractSchema = z
  .object({
    pr: prStateSchema.optional(),
  })
  .passthrough();

export type StateMode = "draft" | "ready";

export type Contract = z.infer<typeof contractSchema>;

export type ReadyData = {
  value: boolean;
  reason?: string | null;
  checked_by?: string | null;
  notes: string[];
  [key: string]: unknown;
};

export type LifecycleData = {
  state: LifecycleState;
  updated_by?: string | null | undefined;
  reason?: string | null | undefined;
  notes: string[];
  [key: string]: unknown;
};

export type PrStateData = {
  title?: string | undefined;
  ready: ReadyData;
  lifecycle: LifecycleData;
  [key: string]: unknown;
};

export type DerivedInfo = {
  mode: StateMode;
  state: LifecycleState;
  title?: string | undefined;
  reason?: string | null | undefined;
};

function defaultReadyReason(state: LifecycleState): string {
  if (isReadyState(state)) {
    return `Lifecycle state \`${state}\` implies the PR is ready for review.`;
  }

  return `Lifecycle state \`${state}\` implies the PR should stay draft.`;
}

export function ensurePrState(contract: Contract): PrStateData {
  const parsed = contractSchema.parse(contract);
  const pr = { ...(parsed.pr ?? {}) };
  const lifecycleInput = pr.lifecycle ?? {};
  const state = lifecycleStateSchema.parse(lifecycleInput.state ?? "drafting");

  const lifecycle: LifecycleData = {
    ...lifecycleInput,
    state,
    notes: [...(lifecycleInput.notes ?? [])],
  };

  const readyInput = pr.ready ?? {};
  const ready: ReadyData = {
    ...readyInput,
    value: readyInput.value ?? isReadyState(state),
    reason: readyInput.reason ?? null,
    checked_by: readyInput.checked_by ?? null,
    notes: [...(readyInput.notes ?? [])],
  };

  return {
    ...pr,
    title: pr.title,
    ready,
    lifecycle,
  };
}

export function syncReady(pr: PrStateData): PrStateData {
  const state = pr.lifecycle.state;
  pr.ready.value = isReadyState(state);

  if (!pr.ready.reason) {
    pr.ready.reason = defaultReadyReason(state);
  }

  return pr;
}

export function loadContract(path: string): Contract {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Contract;
  const parsed = contractSchema.parse(raw);
  const pr = ensurePrState(parsed);
  return {
    ...parsed,
    pr,
  };
}

export function writeContract(path: string, contract: Contract): void {
  writeFileSync(path, `${JSON.stringify(contract, null, 2)}\n`);
}

export function deriveInfo(contract: Contract): DerivedInfo {
  const pr = ensurePrState(contract);
  const state = pr.lifecycle.state;
  const isReady = pr.ready.value || isReadyState(state);

  return {
    mode: isReady ? "ready" : "draft",
    state,
    title: pr.title,
    reason: pr.lifecycle.reason ?? pr.ready.reason,
  };
}

export function applyTransition(
  contract: Contract,
  newState: LifecycleState,
  actor: string,
  reason?: string | null,
): Contract {
  const pr = ensurePrState(contract);
  const currentState = pr.lifecycle.state;

  pr.lifecycle.state = newState;
  pr.lifecycle.updated_by = actor;
  pr.lifecycle.reason = reason ?? null;
  pr.lifecycle.notes.push(`${actor} moved lifecycle from \`${currentState}\` to \`${newState}\``);

  syncReady(pr);
  pr.ready.checked_by = actor;

  return {
    ...contract,
    pr,
  };
}

export function recordEvent(
  contract: Contract,
  event: string,
  actor: string,
  reason?: string | null,
): Contract {
  const pr = ensurePrState(contract);
  pr.lifecycle.updated_by = actor;
  if (reason !== undefined) {
    pr.lifecycle.reason = reason;
  }
  const reasonSuffix = reason ? ` (${reason})` : "";
  pr.lifecycle.notes.push(`${actor} recorded event \`${event}\`${reasonSuffix}`);

  return {
    ...contract,
    pr,
  };
}
