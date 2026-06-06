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

import { createHash } from "node:crypto";

import { getEnv } from "@bounded-systems/env";
import { spawnCapture } from "@bounded-systems/proc";

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
  ChecksGate,
  CiGate,
  IntakeRunner,
  LegAttestation,
  LegRunner,
  MergeRunner,
  PilotDeps,
} from "../machine/machines/pilot.ts";
import type { TaskRole } from "../machine/machines/task.ts";
import { recordEvent } from "../machine/record_event.ts";
import { runPlanSave } from "../plan-store/verbs.ts";
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
  opts: {
    cwd: string;
    workUnitId?: string;
    timeoutMs?: number;
    onStreamEvent?: (e: { kind: string; text?: string }) => void;
  },
) => Promise<NonInteractiveAgentResult>;

/** GH-261: a meaningful per-leg heartbeat — progress, not a bare liveness ping. */
export type LegHeartbeat = {
  workUnitId: string;
  role: string;
  /** assistant turns emitted so far (progress count). */
  turns: number;
  /** cumulative assistant-text length (progress volume). */
  chars: number;
  /** ms since this leg started. */
  elapsedMs: number;
  /** truncated snippet of the latest assistant output — WHAT the leg is doing now. */
  last: string;
};

/**
 * GH-261: per-leg IDLE threshold (NOT a total-runtime cap). `agent_service`'s
 * watchdog resets on every streamed message, so a long-but-ACTIVE leg never
 * trips — only genuine silence does. The pilot legs previously passed none, so a
 * stalled leg (silent stream / stray approval wait — the GH-254 drive that hung
 * ~21 min post-author) hung the whole machine forever. With it, sustained
 * silence aborts the run with `reason: "watchdog"` (recorded, distinct from a
 * clean completion) → the leg throws → the pilot RETREATS (budget-bounded). 5
 * min of NO activity is a strong stall signal without cutting active work.
 * Override per-call or via `PRX_PILOT_LEG_IDLE_MS`.
 */
export const DEFAULT_PILOT_LEG_IDLE_MS = 5 * 60 * 1000;

/** GH-261: throttle for the per-leg liveness heartbeat (telemetry actor). */
const LEG_HEARTBEAT_THROTTLE_MS = 15 * 1000;

/**
 * Hard wall-clock cap for the local `prx ci` checks seam — the pipeline analogue
 * of a GitHub job `timeout-minutes`. A hung `prx ci` (install/build/test) would
 * otherwise stall the whole machine; on timeout the spawn is killed → non-zero
 * exit → passed:false → the pilot retreats (budget-bounded). 15 min covers a
 * cold install+build+test. Override per-call or via PRX_PILOT_CHECKS_TIMEOUT_MS.
 */
export const DEFAULT_PILOT_CHECKS_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * A deterministic-seam telemetry observation — parity with the LLM-leg heartbeat
 * (GH-261). The seams (intake/checks/ci/merge) are synchronous shell-outs with
 * no stream, so instead of a throttled progress beat they emit a start/done (or
 * error) pair, carrying elapsed time so an observer can see WHERE a run sits.
 */
export type SeamObservation = {
  workUnitId: string;
  /** intake | checks | ci | merge */
  seam: string;
  phase: "start" | "done" | "error";
  /** ms since the seam started (absent on "start"). */
  elapsedMs?: number;
  /** error message on "error". */
  error?: string;
};

export type RealLegDeps = {
  openSession?: OpenSessionFn;
  runAgent?: RunAgentFn;
  signer?: Signer | null;
  /** How CI-gate / merge legs shell out to the prx runtime (injectable). */
  runPrx?: RunPrx;
  /** GH-261: per-leg IDLE-watchdog threshold (ms). Defaults to DEFAULT_PILOT_LEG_IDLE_MS. */
  legIdleMs?: number;
  /** GH-261: heartbeat sink (defaults to recordEvent → telemetry actor). Injectable for tests. */
  onLegHeartbeat?: (info: LegHeartbeat) => void;
  /** Hard timeout for the local `prx ci` checks seam (ms). Defaults to DEFAULT_PILOT_CHECKS_TIMEOUT_MS. */
  checksTimeoutMs?: number;
  /** Seam telemetry sink (defaults to recordEvent → telemetry actor). Injectable for tests. */
  onSeamObserved?: (info: SeamObservation) => void;
  /** GH-325: persist the planner's plan → `plan@draft` (defaults to runPlanSave). */
  savePlan?: typeof runPlanSave;
};

/** GH-261: bound the heartbeat's activity snippet so audit rows stay small. */
const LEG_HEARTBEAT_SNIPPET_MAX = 140;

/**
 * Run a `prx <args>` invocation. The capability boundary for tail effects.
 * `opts.cwd` lets a seam run in the unit's worktree — the local `prx ci` gate
 * needs it (the GH-facing seams don't, so it stays optional / process-CWD).
 * `opts.timeoutMs` caps a long-running shell-out (the checks seam's `prx ci`);
 * on timeout the process is killed → non-zero exit (the pipeline analogue of a
 * GitHub job `timeout-minutes`).
 */
export type RunPrx = (
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number },
) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

/** Default: shell the installed `prx` binary (via @bounded-systems/proc). */
export const realRunPrx: RunPrx = async (args, opts) => {
  const r = spawnCapture(["prx", ...args], {
    ...(opts?.cwd ? { cwd: opts.cwd } : {}),
    ...(opts?.timeoutMs ? { timeout: opts.timeoutMs } : {}),
  });
  return { ok: r.status === 0, stdout: r.stdout, stderr: r.stderr };
};

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
  const savePlan = deps.savePlan ?? runPlanSave;
  // GH-261: resolve the per-leg IDLE threshold. Explicit dep wins; else env
  // override; else the default. ≤0 disables it (back to no watchdog).
  const envIdle = Number(getEnv("PRX_PILOT_LEG_IDLE_MS"));
  const legIdleMs = deps.legIdleMs
    ?? (Number.isFinite(envIdle) && envIdle > 0 ? envIdle : DEFAULT_PILOT_LEG_IDLE_MS);
  // GH-261: liveness heartbeat → the telemetry actor's TELEMETRY_LEG_OBSERVED
  // event. Lets an observer SEE a leg making progress (and pinpoint where it
  // goes silent) — feedback the bare watchdog can't give. Best-effort + throttled.
  const heartbeat = deps.onLegHeartbeat
    ?? ((info: LegHeartbeat) => {
      try {
        recordEvent("TELEMETRY_LEG_OBSERVED", {
          workUnitId: info.workUnitId,
          details: { role: info.role, turns: info.turns, chars: info.chars, elapsedMs: info.elapsedMs, last: info.last },
        });
      } catch {
        // observability is best-effort — never break a leg on a sink error.
      }
    });

  const roleAgent: RunRoleAgent = async (input) => {
    const actor = roleSessionActor[input.role];
    const opened = await open({ actor, workUnitId: input.workUnitId, interaction: "headless" });
    if (opened.status !== "opened" || !opened.profile) {
      throw new Error(`openSession(${input.role}/${actor}) → status=${opened.status}, no profile`);
    }
    // GH-261: accumulate real progress so the heartbeat carries WHAT the leg is
    // doing (turns/chars/elapsed + the latest output snippet), not just "alive".
    const startedAt = Date.now();
    let turns = 0;
    let chars = 0;
    let last = "";
    let lastBeat = 0;
    const result = await runAgent(opened.profile, {
      cwd: opened.worktree_path,
      workUnitId: input.workUnitId,
      ...(legIdleMs > 0 ? { timeoutMs: legIdleMs } : {}),
      onStreamEvent: (e) => {
        // Full assistant turns are the meaningful progress unit; partial deltas
        // only keep `last` fresh between turns. Either way it's live activity.
        if (typeof e.text === "string" && e.text.length > 0) {
          if (e.kind === "assistant_text") {
            turns += 1;
            chars += e.text.length;
          }
          last = e.text.replace(/\s+/g, " ").trim().slice(0, LEG_HEARTBEAT_SNIPPET_MAX);
        }
        const t = Date.now();
        if (t - lastBeat >= LEG_HEARTBEAT_THROTTLE_MS) {
          lastBeat = t;
          heartbeat({ workUnitId: input.workUnitId, role: input.role, turns, chars, elapsedMs: t - startedAt, last });
        }
      },
    });
    // GH-325: persist the planner's plan to `plan@draft` so the executor can
    // consume it. The pilot path wires no draftSink (that only fires on cancel),
    // so save the rendered plan explicitly after a successful planner leg. A
    // save failure surfaces downstream as a missing plan → the executor fails
    // closed rather than running blind.
    if (input.role === "planner" && result.kind === "success" && result.text.trim().length > 0) {
      try {
        await savePlan({ unit: input.workUnitId, slot: "draft", content: result.text });
      } catch {
        /* best-effort persist */
      }
    }
    return result;
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

export type ChecksDeps = {
  runPrx: RunPrx;
  signer: Signer;
  /** Resolve the unit's worktree to run `prx ci` in. Injectable for tests. */
  openSession?: OpenSessionFn;
  /** Hard timeout for `prx ci` (ms). Defaults to DEFAULT_PILOT_CHECKS_TIMEOUT_MS. */
  timeoutMs?: number;
};

/**
 * Real local-CI gate: resolve the unit's implement worktree, run `prx ci`
 * (install→typecheck→docs→build→test) THERE, and sign a `gate@checks-local`
 * link. Non-zero exit ⇒ passed:false ⇒ the pilot retreats to `executing`
 * (budget-bounded). Mirrors `buildRealCiGate`, local instead of remote — it
 * fails fast on the real CI surface before the LLM tester/reviewer legs and the
 * remote CI gate. See docs/prx/pipeline-local-checks.md.
 */
export function buildRealChecks(deps: ChecksDeps): ChecksGate {
  const sign = realRoleSigner(deps.signer);
  const open = deps.openSession ?? (openSession as OpenSessionFn);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PILOT_CHECKS_TIMEOUT_MS;
  return async ({ workUnitId }) => {
    const opened = await open({ actor: "implement", workUnitId, interaction: "headless" });
    if (opened.status !== "opened" || !opened.worktree_path) {
      throw new Error(`openSession(checks/implement) for ${workUnitId} → status=${opened.status}, no worktree`);
    }
    const res = await deps.runPrx(["ci"], { cwd: opened.worktree_path, timeoutMs });
    const passed = res.ok;
    const attestation = await signStageLink(
      sign,
      "checks",
      `${workUnitId}:gate@checks-local`,
      passed ? "checks.passed" : "checks.failed",
      sha256Hex(`${res.stdout}\n${res.stderr}`),
    );
    return { passed, attestation };
  };
}

export type IntakeDeps = { runPrx: RunPrx; signer: Signer };

/**
 * GH-232: real intake leg — `prx intake source <unit>` (the same verb a human
 * runs) resolves + pins the chain ROOT `<unit>:source@pinned`; signs a
 * `source.pinned` link. On failure it throws → the pilot blocks (no plan without
 * a source). This is what makes the headless planner CONSUME the real issue
 * instead of fabricating (GH-230).
 */
export function buildRealIntake(deps: IntakeDeps): IntakeRunner {
  const sign = realRoleSigner(deps.signer);
  return async ({ workUnitId }) => {
    const res = await deps.runPrx(["intake", "source", workUnitId, "--format", "json"]);
    if (!res.ok) {
      throw new Error(`intake source failed for ${workUnitId}: ${res.stderr.trim() || res.stdout.trim()}`);
    }
    const attestation = await signStageLink(
      sign,
      "intake",
      `${workUnitId}:source@pinned`,
      "source.pinned",
      sha256Hex(res.stdout),
    );
    return { attestation };
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

/** Default seam-telemetry sink: best-effort recordEvent (never breaks a seam). */
function recordSeamObservation(info: SeamObservation): void {
  try {
    recordEvent("TELEMETRY_SEAM_OBSERVED", {
      workUnitId: info.workUnitId,
      details: {
        seam: info.seam,
        phase: info.phase,
        ...(info.elapsedMs !== undefined ? { elapsedMs: info.elapsedMs } : {}),
        ...(info.error !== undefined ? { error: info.error } : {}),
      },
    });
  } catch {
    // observability is best-effort — never break a seam on a sink error.
  }
}

/**
 * Wrap a deterministic seam so it emits start/done/error telemetry — parity with
 * the LLM legs' heartbeat (GH-261), which the GH-facing seams previously lacked.
 * The sink is best-effort; the seam's own result/throw passes through unchanged.
 */
function observeSeam<I extends { workUnitId: string }, R>(
  seam: string,
  emit: (info: SeamObservation) => void,
  fn: (input: I) => Promise<R>,
): (input: I) => Promise<R> {
  return async (input) => {
    const startedAt = Date.now();
    emit({ workUnitId: input.workUnitId, seam, phase: "start" });
    try {
      const r = await fn(input);
      emit({ workUnitId: input.workUnitId, seam, phase: "done", elapsedMs: Date.now() - startedAt });
      return r;
    } catch (e) {
      emit({
        workUnitId: input.workUnitId,
        seam,
        phase: "error",
        elapsedMs: Date.now() - startedAt,
        error: String((e as Error)?.message ?? e),
      });
      throw e;
    }
  };
}

/**
 * Full real `PilotDeps`: real leg-runner + summary signing + the intake / local
 * checks / remote CI / merge seams wired to `prx` (via `runPrx`). Each seam is
 * wrapped with `observeSeam` for telemetry parity with the LLM legs, and the
 * checks seam carries a hard `prx ci` timeout.
 */
export function buildRealPilotDeps(deps: RealLegDeps = {}): PilotDeps {
  const signer = resolveSignerOrThrow(deps.signer);
  const runPrx = deps.runPrx ?? realRunPrx;
  const emitSeam = deps.onSeamObserved ?? recordSeamObservation;
  const envChecksTimeout = Number(getEnv("PRX_PILOT_CHECKS_TIMEOUT_MS"));
  const checksTimeoutMs = deps.checksTimeoutMs
    ?? (Number.isFinite(envChecksTimeout) && envChecksTimeout > 0 ? envChecksTimeout : DEFAULT_PILOT_CHECKS_TIMEOUT_MS);
  return {
    runLeg: buildRealLegRunner({ ...deps, signer }),
    runIntake: observeSeam("intake", emitSeam, buildRealIntake({ runPrx, signer })),
    runChecks: observeSeam(
      "checks",
      emitSeam,
      buildRealChecks({
        runPrx,
        signer,
        timeoutMs: checksTimeoutMs,
        ...(deps.openSession ? { openSession: deps.openSession } : {}),
      }),
    ),
    signSummary: realStatementSigner(signer),
    runCiGate: observeSeam("ci", emitSeam, buildRealCiGate({ runPrx, signer })),
    runMerge: observeSeam("merge", emitSeam, buildRealMerge({ runPrx, signer })),
  };
}

/** Whether `prx pilot` should drive real subagents (`PRX_PILOT_REAL` truthy). */
export function wantsRealPilot(env: (key: string) => string | undefined = getEnv): boolean {
  const v = env("PRX_PILOT_REAL");
  return v === "1" || v === "true" || v === "on";
}
