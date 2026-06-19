// `prx event` (a.k.a. `contract event`) as a deps-bearing VerbSpec migrated off
// cli.ts (ADR docs/prx/cli-decomposition.md). It applies a pr-skill's lifecycle
// event to the contract: a transition skill advances the state (or records a
// blocked-transition observation when the move is invalid for the current
// state); a non-transition skill just records the event. `event` appends a
// transition-log entry on a successful transition; the `contract` command
// reuses `applySkillEvent` with `logTransition: false` (pr-contract, no log).

import { z } from "zod";

import { defineVerb } from "@bounded-systems/verbspec";
import { detectBranchNameFromCwd, tryCommand } from "./cli-spawn.ts";
import {
  applyTransition,
  deriveInfo,
  loadContract,
  recordEvent,
  writeContract,
} from "./contract.ts";
import { appendTransitionLog, type TransitionEntry } from "./transition_log.ts";
import {
  assertValidTransition,
  eventForSkill,
  prSkillNames,
  type LifecycleState,
  type PrSkillName,
  type SkillEventDefinition,
} from "../machine/machines/pr.ts";

export type SkillEventDeps = {
  detectBranchNameFromCwd: typeof detectBranchNameFromCwd;
  tryCommand: typeof tryCommand;
};
const realSkillEventDeps = (): SkillEventDeps => ({ detectBranchNameFromCwd, tryCommand });

export type SkillEventInput = {
  contract: string;
  skill: PrSkillName;
  actor: string;
  reason?: string | null | undefined;
  log: string;
  id?: string | undefined;
};

export type SkillEventPayload = {
  skill: PrSkillName;
  event: string;
  kind: string;
  from: LifecycleState;
  to: LifecycleState;
  transitionApplied: boolean;
  blockedTransition: { from: LifecycleState; to: LifecycleState } | null;
  state: LifecycleState;
  mode: string;
  title: string | undefined;
  reason: string | null | undefined;
};

/**
 * Apply `input.skill`'s event to the contract at `input.contract`, persist it,
 * and return the resulting machine-derived payload. When `opts.logTransition`
 * is set and a real transition landed, append a transition-log entry (the
 * `event` verb does; the `contract` command does not). Shared by both.
 */
export function applySkillEvent(
  input: SkillEventInput,
  opts: { logTransition: boolean },
  deps: SkillEventDeps = realSkillEventDeps(),
): SkillEventPayload {
  const contract = loadContract(input.contract);
  const from = deriveInfo(contract).state;
  const definition: SkillEventDefinition = eventForSkill(input.skill);

  let nextContract: typeof contract;
  let appliedTransition = false;
  let blockedTransition: { from: LifecycleState; to: LifecycleState } | null = null;

  if (definition.kind === "transition") {
    try {
      assertValidTransition(from, definition.to);
      nextContract = applyTransition(
        contract,
        definition.to,
        input.actor,
        input.reason ?? definition.event,
      );
      appliedTransition = true;
    } catch {
      nextContract = recordEvent(
        contract,
        definition.event,
        input.actor,
        input.reason ?? `Transition blocked from ${from} to ${definition.to}`,
      );
      blockedTransition = { from, to: definition.to };
    }
  } else {
    nextContract = recordEvent(contract, definition.event, input.actor, input.reason);
  }

  writeContract(input.contract, nextContract);

  if (opts.logTransition && appliedTransition && definition.kind === "transition") {
    const branch = deps.detectBranchNameFromCwd();
    const commit = deps.tryCommand(["git", "rev-parse", "--short=12", "HEAD"], process.cwd());
    const logEntry: TransitionEntry = {
      id: input.id ?? crypto.randomUUID(),
      issue: branch,
      state_from: from,
      state_to: definition.to,
      actor: input.actor,
      artifact: branch ? `branch:${branch}` : null,
      timestamp: new Date().toISOString(),
      proof: { commit },
    };
    appendTransitionLog(input.log, logEntry);
  }

  const info = deriveInfo(loadContract(input.contract));
  return {
    skill: input.skill,
    event: definition.event,
    kind: definition.kind === "transition" && !appliedTransition ? "observe" : definition.kind,
    from,
    to: definition.kind === "transition" ? definition.to : from,
    transitionApplied: appliedTransition,
    blockedTransition,
    state: info.state,
    mode: info.mode,
    title: info.title,
    reason: info.reason,
  };
}

export const EventOutput = z
  .object({
    skill: z.string(),
    event: z.string(),
    kind: z.string(),
    from: z.string(),
    to: z.string(),
    transitionApplied: z.boolean(),
    blockedTransition: z.object({ from: z.string(), to: z.string() }).nullable(),
    state: z.string(),
    mode: z.string(),
    title: z.string().nullish(),
    reason: z.string().nullish(),
  })
  .loose();
export type EventOutput = z.infer<typeof EventOutput>;

export const eventVerb = defineVerb({
  id: "event",
  summary:
    "Apply a pr-skill's lifecycle event to the contract (advancing the state or recording a blocked transition).",
  actor: "work",
  input: z.object({
    contract: z.string().default(".pr/local/pr.json").describe("path to the pr contract"),
    skill: z.enum(prSkillNames).describe("the pr-skill whose event to apply"),
    actor: z.string().default("codex").describe("actor recording the event"),
    reason: z.string().optional().describe("reason recorded with the event"),
    format: z.enum(["plain", "json"]).default("plain").describe("output format"),
    log: z.string().default(".prx/transitions.jsonl").describe("transition log path"),
    id: z.string().optional().describe("explicit transition id (defaults to a random uuid)"),
  }),
  output: EventOutput,
  deps: realSkillEventDeps,
  run: (input, deps: SkillEventDeps = realSkillEventDeps()): EventOutput =>
    applySkillEvent(
      {
        contract: input.contract,
        skill: input.skill,
        actor: input.actor,
        reason: input.reason,
        log: input.log,
        id: input.id,
      },
      { logTransition: true },
      deps,
    ),
  render: (out, input) =>
    input.format === "json"
      ? JSON.stringify(out, null, 2)
      : `${out.state} (${out.mode}) - ${out.event} via ${out.skill}`,
});
