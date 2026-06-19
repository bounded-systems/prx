/**
 * SPIKE — production `LegRunner` for the pilot machine.
 *
 * Bridges the pure pilot machine (`pilot.ts`) to the real world: each leg runs
 * the role as a headless Claude session ("claude over ssh") and signs the
 * result into a provenance link. Both sides are INJECTED so this is unit-
 * testable without a live API call or a real key:
 *
 *   - `runAgent`  → in prod, `runClaudeAgentNonInteractive(roleProfile, …)`
 *                   (packages/prx/src/claude/agent_service.ts) — the existing
 *                   per-role headless SDK path with scoped tools, audit,
 *                   watchdog. That IS the role subagent.
 *   - `sign`      → in prod, the role actor's Signer over the anchored chain
 *                   (the in-toto / `gate actors as signed attestations` work).
 *
 * Outcome mapping:
 *   success   → advance, sign a `<role>.completed` link.
 *   cancelled → no advance (parks in `blocked`), still sign a `<role>.blocked`
 *               link so the stop is itself on the provenance record.
 *   failed    → throw, so the machine retreats along its failure edge
 *               (executor → planning) rather than minting a bogus link.
 */

import { createHash } from "node:crypto";

import type { NonInteractiveAgentResult } from "../../claude/agent_service.ts";
import type { TaskRole } from "./task.ts";
import { roleProfile, type LegInput, type LegRunner } from "./pilot.ts";

/** Run one role as a headless agent. Prod = `runClaudeAgentNonInteractive`. */
export type RunRoleAgent = (input: LegInput) => Promise<NonInteractiveAgentResult>;

/** Sign a provenance link with the role actor's authority. Prod = anchored-chain Signer. */
export type RoleSigner = (input: {
  role: TaskRole;
  subject: string;
  predicate: string;
  outputHash: string;
}) => Promise<{ signedBy: string; sig: string }>;

export type SdkLegRunnerDeps = {
  runAgent: RunRoleAgent;
  sign: RoleSigner;
  /** Override the content hash (tests). Default: sha256 hex of the agent text. */
  hash?: (text: string) => string;
};

const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * Build the production `LegRunner`. Drop the result into `createPilotMachine`
 * and the pilot self-drives over real role agents, signing each leg.
 */
export function createSdkLegRunner(deps: SdkLegRunnerDeps): LegRunner {
  const hash = deps.hash ?? sha256Hex;
  return async (input) => {
    const run = await deps.runAgent(input);

    if (run.kind === "failed") {
      // Throw → onError edge in the machine retreats to the prior role.
      throw new Error(`[${input.role}] agent failed (${run.errorKind}): ${run.message}`);
    }

    // GH-289: a planner that submits a REJECTION (`decision: "blocked"`) succeeded
    // as an agent run but produced no viable plan — do NOT advance. Halting here
    // (advance=false → the pilot's planning→blocked edge) stops the cascade where
    // executor/tester/author flail over an empty plan (the GH-286 drive bug).
    const rejected = run.kind === "success" && run.planDecision === "blocked";
    const advance = run.kind === "success" && !rejected;
    const text = run.kind === "success" ? run.text : run.partialStdout;
    const outputHash = hash(text);
    const subject = `${input.workUnitId}:${input.profile.signs}`;
    const predicate = rejected
      ? `${input.role}.rejected`
      : advance
        ? `${input.role}.completed`
        : `${input.role}.blocked`;

    const { signedBy, sig } = await deps.sign({ role: input.role, subject, predicate, outputHash });

    return {
      role: input.role,
      advance,
      attestation: { stage: input.role, subject, predicate, signedBy, sig },
    };
  };
}

/**
 * Convenience: the prod wiring expressed as a single factory once a caller has
 * the two real deps in hand. Kept here (not in `pilot.ts`) so the pure machine
 * never imports the SDK or the signer. `roleProfile` is re-exported for callers
 * building the per-role agent profile.
 */
export { roleProfile };
