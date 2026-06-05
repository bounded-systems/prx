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

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

import { getEnv } from "@bounded-systems/env";

import {
  runClaudeAgentNonInteractive,
  type NonInteractiveAgentResult,
} from "../claude/agent_service.ts";
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
import type {
  CiGate,
  LegAttestation,
  LegRunner,
  MergeRunner,
  PilotDeps,
} from "../machine/machines/pilot.ts";
import type { TaskRole } from "../machine/machines/task.ts";
import { requireSigner } from "./agent-signing-guard.ts";

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
  /** How CI-gate / merge legs shell out to the prx runtime (injectable). */
  runPrx?: RunPrx;
};

/** Run a `prx <args>` invocation. The capability boundary for tail effects. */
export type RunPrx = (args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

/** Default: shell the installed `prx` binary. */
export const realRunPrx: RunPrx = (args) =>
  new Promise((resolve) => {
    execFile("prx", args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });

const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Sign a tail link (`ci` / `merge`) with the actor's authority. */
async function signStageLink(
  sign: ReturnType<typeof realRoleSigner>,
  stage: string,
  subject: string,
  predicate: string,
  outputHash: string,
): Promise<LegAttestation> {
  const { signedBy, sig } = await sign({ role: stage as unknown as TaskRole, subject, predicate, outputHash });
  return { stage, subject, predicate, signedBy, sig };
}

function resolveSignerOrThrow(signer?: Signer | null, actorLabel = "pilot"): Signer {
  // The invariant: no agent launches unsigned. An explicitly-injected signer
  // wins (tests); otherwise the ambient actor's key must resolve, or we refuse.
  return signer ?? requireSigner(actorLabel);
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

type CiConclusion = "success" | "failure" | "pending" | "unknown";

/** Map `prx scout ci --format json` output to a settled/pending conclusion. */
export function parseCiConclusion(stdout: string): CiConclusion {
  try {
    const j = JSON.parse(stdout) as { status?: string; conclusion?: string; state?: string };
    const v = (j.conclusion ?? j.status ?? j.state ?? "").toLowerCase();
    if (["success", "passed", "green", "neutral"].includes(v)) return "success";
    if (["failure", "failed", "red", "error", "cancelled", "timed_out"].includes(v)) return "failure";
    if (["pending", "queued", "in_progress", "running", "waiting"].includes(v)) return "pending";
    return "unknown";
  } catch {
    return "unknown";
  }
}

export type CiGateDeps = {
  runPrx: RunPrx;
  signer: Signer;
  maxPolls?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Real CI gate: poll `prx scout ci <unit>` until CI SETTLES (green/red). Pending
 * never resolves to an advance — that is the hard block, by construction. A gate
 * that never settles within `maxPolls` throws, so the machine retreats (bounded
 * by the retreat budget — termination preserved). Signs a `gate@ci-remote` link.
 */
export function buildRealCiGate(deps: CiGateDeps): CiGate {
  const sign = realRoleSigner(deps.signer);
  const maxPolls = deps.maxPolls ?? 60;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  return async ({ workUnitId }) => {
    let conclusion: CiConclusion = "pending";
    let last = "";
    for (let i = 0; i < maxPolls; i++) {
      const res = await deps.runPrx(["scout", "ci", workUnitId, "--format", "json"]);
      last = res.stdout;
      conclusion = res.ok ? parseCiConclusion(res.stdout) : "unknown";
      if (conclusion === "success" || conclusion === "failure") break;
      await sleep(deps.pollMs ?? 10_000); // pending → keep waiting
    }
    if (conclusion !== "success" && conclusion !== "failure") {
      throw new Error(`CI did not settle for ${workUnitId} (last=${conclusion})`);
    }
    const passed = conclusion === "success";
    const attestation = await signStageLink(
      sign,
      "ci",
      `${workUnitId}:gate@ci-remote`,
      passed ? "ci.passed" : "ci.failed",
      sha256Hex(last),
    );
    return { passed, attestation };
  };
}

export type MergeDeps = { runPrx: RunPrx; signer: Signer };

/** Real merge: `prx publisher merge <unit>` (forge merges); signs `merged@pr`. */
export function buildRealMerge(deps: MergeDeps): MergeRunner {
  const sign = realRoleSigner(deps.signer);
  return async ({ workUnitId }) => {
    const res = await deps.runPrx(["publisher", "merge", workUnitId]);
    if (!res.ok) {
      throw new Error(`publisher merge failed for ${workUnitId}: ${res.stderr.trim() || res.stdout.trim()}`);
    }
    const attestation = await signStageLink(
      sign,
      "merge",
      `${workUnitId}:merged@pr`,
      "pr.merged",
      sha256Hex(res.stdout),
    );
    return { attestation };
  };
}

/**
 * Full real `PilotDeps`: real leg-runner + summary signing + the CI-gate and
 * merge legs wired to `prx scout ci` / `prx publisher merge` (via `runPrx`).
 */
export function buildRealPilotDeps(deps: RealLegDeps = {}): PilotDeps {
  const signer = resolveSignerOrThrow(deps.signer);
  const runPrx = deps.runPrx ?? realRunPrx;
  return {
    runLeg: buildRealLegRunner({ ...deps, signer }),
    signSummary: realStatementSigner(signer),
    runCiGate: buildRealCiGate({ runPrx, signer }),
    runMerge: buildRealMerge({ runPrx, signer }),
  };
}

/** Whether `prx pilot` should drive real subagents (`PRX_PILOT_REAL` truthy). */
export function wantsRealPilot(env: (key: string) => string | undefined = getEnv): boolean {
  const v = env("PRX_PILOT_REAL");
  return v === "1" || v === "true" || v === "on";
}
