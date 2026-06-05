/**
 * Production wiring for `prx pilot` — drive the pilot over REAL Claude
 * subagents and REAL signatures, replacing the spike's stubs.
 *
 * Each leg reuses the exact path the CLI verbs use: `openSession({actor})`
 * materializes the unit's worktree and builds the per-role runtime profile,
 * then `runClaudeAgentNonInteractive` runs that role headless ("claude over
 * ssh"). The result is signed with the role's authority via the anchored-chain
 * Signer (`resolveProvenanceSigner`). All three I/O seams (openSession, the
 * agent run, the signer) are injectable, so this is unit-testable without a
 * live API call — the test mocks them and asserts real ed25519 signatures.
 *
 * Gated behind `PRX_PILOT_REAL`; default `prx pilot` stays stub-driven.
 */

import { getEnv } from "@bounded-systems/env";

import {
  runClaudeAgentNonInteractive,
  type NonInteractiveAgentResult,
} from "../claude/agent_service.ts";
import { resolveProvenanceSigner } from "../provenance/signer.ts";
import { openSession, type OpenSessionResult } from "../session/open.ts";
import type { SessionActor } from "../session/schema.ts";
import {
  createSdkLegRunner,
  type RunRoleAgent,
} from "../machine/machines/pilot-runner.ts";
import {
  realRoleSigner,
  realStatementSigner,
  type Signer,
} from "../machine/machines/pilot-signing.ts";
import type { LegRunner, PilotDeps } from "../machine/machines/pilot.ts";
import type { TaskRole } from "../machine/machines/task.ts";

/**
 * Role → the `openSession` actor that runs it. `tester` runs in the implement
 * worktree (it executes the unit's tests); planner/executor/reviewer map to
 * their canonical session actors.
 */
export const roleSessionActor: Record<TaskRole, SessionActor> = {
  planner: "plan",
  executor: "implement",
  tester: "implement",
  reviewer: "author",
};

export type OpenSessionFn = (input: {
  actor: SessionActor;
  workUnitId: string;
  interaction?: "headless" | "interactive";
}) => Promise<OpenSessionResult>;

export type RunAgentFn = (
  profile: NonNullable<OpenSessionResult["profile"]>,
  opts: { cwd: string; workUnitId?: string },
) => Promise<NonInteractiveAgentResult>;

export type RealLegDeps = {
  openSession?: OpenSessionFn;
  runAgent?: RunAgentFn;
  signer?: Signer | null;
};

function resolveSignerOrThrow(signer?: Signer | null): Signer {
  const s = signer ?? (resolveProvenanceSigner() as Signer | null);
  if (!s) {
    throw new Error(
      "buildRealLegRunner: no provenance signer configured (set PRX_PROVENANCE_KEY=dev or ed25519:<b64>)",
    );
  }
  return s;
}

/** Real leg-runner: openSession(role) → headless agent run → sign. */
export function buildRealLegRunner(deps: RealLegDeps = {}): LegRunner {
  const open = deps.openSession ?? (openSession as OpenSessionFn);
  const runAgent = deps.runAgent ?? (runClaudeAgentNonInteractive as unknown as RunAgentFn);
  const sign = realRoleSigner(resolveSignerOrThrow(deps.signer));

  const roleAgent: RunRoleAgent = async (input) => {
    const actor = roleSessionActor[input.role];
    const opened = await open({ actor, workUnitId: input.workUnitId, interaction: "headless" });
    if (opened.status !== "opened" || !opened.profile) {
      throw new Error(`openSession(${input.role}/${actor}) → status=${opened.status}, no profile`);
    }
    return runAgent(opened.profile, { cwd: opened.worktree_path, workUnitId: input.workUnitId });
  };

  return createSdkLegRunner({ runAgent: roleAgent, sign });
}

/**
 * Full real `PilotDeps`: real leg-runner + real summary signing. The CI gate
 * and merge keep their (auto-pass) defaults for now — wiring those to the real
 * `prx plan ci` / publisher actors is the next slice.
 */
export function buildRealPilotDeps(deps: RealLegDeps = {}): PilotDeps {
  const signer = resolveSignerOrThrow(deps.signer);
  return {
    runLeg: buildRealLegRunner({ ...deps, signer }),
    signSummary: realStatementSigner(signer),
  };
}

/** Whether `prx pilot` should drive real subagents (`PRX_PILOT_REAL` truthy). */
export function wantsRealPilot(env: (key: string) => string | undefined = getEnv): boolean {
  const v = env("PRX_PILOT_REAL");
  return v === "1" || v === "true" || v === "on";
}
