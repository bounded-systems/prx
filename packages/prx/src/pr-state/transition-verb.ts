// `prx transition` as a spec-driven VerbSpec — a deps-bearing write migrated off
// cli.ts via the VerbSpec deps seam (ADR docs/prx/cli-decomposition.md). It
// validates the requested lifecycle move + actor ownership, applies it to the
// contract, appends a transition-log entry, and reports the new status. The
// non-deterministic git reads (branch / commit) are its small `TransitionDeps`
// slice; contract/log writes go through the contract + transition_log leaves.

import { z } from "zod";

import { defineVerb } from "@bounded-systems/verbspec";
import { applyTransition, deriveInfo, loadContract, writeContract } from "./contract.ts";
import { detectBranchNameFromCwd, tryCommand } from "./cli-spawn.ts";
import { renderStatus } from "./status-report.ts";
import {
  appendTransitionLog,
  validateActorOwnership,
  type TransitionEntry,
} from "./transition_log.ts";
import { assertValidTransition, lifecycleStates } from "../machine/machines/pr.ts";

export type TransitionDeps = {
  detectBranchNameFromCwd: typeof detectBranchNameFromCwd;
  tryCommand: typeof tryCommand;
};

const realTransitionDeps = (): TransitionDeps => ({ detectBranchNameFromCwd, tryCommand });

export const TransitionOutput = z
  .object({
    state: z.string(),
    mode: z.string(),
    title: z.string().nullish(),
    reason: z.string().nullish(),
    transition: z.object({
      to: z.string(),
      actor: z.string(),
      reason: z.string().nullable(),
    }),
  })
  .strict();
export type TransitionOutput = z.infer<typeof TransitionOutput>;

export const transitionVerb = defineVerb({
  id: "transition",
  summary: "Apply a lifecycle transition to the PR contract, log it, and report the new status.",
  actor: "work",
  input: z.object({
    contract: z.string().default(".pr/local/pr.json").describe("path to the pr contract"),
    to: z.enum(lifecycleStates).describe("target lifecycle state"),
    actor: z.string().default("codex").describe("actor performing the transition"),
    reason: z.string().optional().describe("reason recorded with the transition"),
    format: z.enum(["plain", "json"]).default("plain").describe("output format"),
    log: z.string().default(".prx/transitions.jsonl").describe("transition log path"),
    id: z.string().optional().describe("explicit transition id (defaults to a random uuid)"),
  }),
  output: TransitionOutput,
  deps: realTransitionDeps,
  run: (input, deps: TransitionDeps = realTransitionDeps()): TransitionOutput => {
    const contract = loadContract(input.contract);
    const currentState = deriveInfo(contract).state;

    try {
      assertValidTransition(currentState, input.to);
    } catch (error) {
      throw new Error(`FAIL: ${(error as Error).message}`);
    }

    try {
      validateActorOwnership(input.actor);
    } catch (error) {
      throw new Error(`FAIL: ${(error as Error).message}`);
    }

    const nextContract = applyTransition(contract, input.to, input.actor, input.reason);
    writeContract(input.contract, nextContract);

    const branch = deps.detectBranchNameFromCwd();
    const commit = deps.tryCommand(["git", "rev-parse", "--short=12", "HEAD"], process.cwd());
    const logEntry: TransitionEntry = {
      id: input.id ?? crypto.randomUUID(),
      issue: branch,
      state_from: currentState,
      state_to: input.to,
      actor: input.actor,
      artifact: branch ? `branch:${branch}` : null,
      timestamp: new Date().toISOString(),
      proof: { commit },
    };
    appendTransitionLog(input.log, logEntry);

    const info = deriveInfo(loadContract(input.contract));
    return {
      state: info.state,
      mode: info.mode,
      title: info.title,
      reason: info.reason,
      transition: { to: input.to, actor: input.actor, reason: input.reason ?? null },
    };
  },
  // json: the structured transition result; plain: the refreshed status line
  // (re-reads the just-written contract, mirroring the legacy handler).
  render: (out, input) =>
    input.format === "json" ? JSON.stringify(out, null, 2) : renderStatus(input.contract, "plain"),
});
