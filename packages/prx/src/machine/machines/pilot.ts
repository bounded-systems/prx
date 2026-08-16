/**
 * SPIKE (spike/pipeline-driven-task) — Layer-1 "pilot": drive ONE work unit
 * through the pipeline of role legs + a CI-gated merge tail, self-advancing.
 *
 * Converged architecture (see docs/prx/pipeline-orchestrator.md):
 *
 *   - The ENGINE is the Claude Agent SDK host loop + this XState machine.
 *   - Each ROLE is a real Claude subagent (planner/executor/tester/reviewer),
 *     a leaf with a scoped `tools:` allowlist. Subagents can't nest, so pilot +
 *     fleet are NOT subagents — they are the host loop.
 *   - No tmux. A leg is a headless `query()` against one role subagent.
 *   - Every actor SIGNS. Each leg, the CI gate, and the merge emit a signed
 *     in-toto link; on `sealing` the pilot mints a summary statement over the
 *     whole chain (prx.pilot/v1) — its own in-toto artifact (see provenance.ts).
 *   - CI is a HARD BLOCK by construction: the only edge toward `merged` runs
 *     through `awaiting_ci`, which advances only on a settled-green gate.
 *   - Termination is PROVEN, not assumed (see `pilotMeasure`).
 */

import { fromPromise, setup } from "xstate";

import type { TaskRole } from "./task.ts";
import {
  buildStatement,
  digestOf,
  stubStatementSigner,
  type Statement,
  type StatementSigner,
} from "./provenance.ts";

/**
 * Per-role binding: the subagent that runs the leg, its scoped tool allowlist
 * (more restrictive than the host — native subagent enforcement), and the
 * artifact this role's authority signs.
 */
export const roleProfile: Record<
  TaskRole,
  { agent: string; tools: readonly string[]; signs: string }
> = {
  planner: { agent: "planner", tools: ["Read", "Grep", "Glob"], signs: "plan@draft" },
  executor: {
    agent: "executor",
    tools: ["Read", "Edit", "Write", "Bash"],
    signs: "implement@latest",
  },
  tester: { agent: "tester", tools: ["Read", "Bash"], signs: "review@validated" },
  reviewer: { agent: "reviewer", tools: ["Read", "Grep"], signs: "submit@ready" },
};

/**
 * A signed provenance link (in-toto step). `stage` is the leg/gate/merge that
 * produced it; `subject` the artifact, `predicate` what was done, `signedBy`
 * the acting actor's identity, `sig` the signature. The ordered list is the
 * unit's chain; the pilot summary statement names them by digest.
 */
export type LegAttestation = {
  stage: string;
  subject: string;
  predicate: string;
  signedBy: string;
  sig: string;
};

export type LegInput = {
  role: TaskRole;
  profile: (typeof roleProfile)[TaskRole];
  workUnitId: string;
};

export type LegResult = {
  role: TaskRole;
  advance: boolean;
  attestation: LegAttestation;
};

/** Run one role as a headless agent + sign. The single shared seam. */
export type LegRunner = (input: LegInput) => Promise<LegResult>;

/** Poll/await remote CI; resolves only when SETTLED (pending never resolves). */
export type CiGate = (input: { workUnitId: string }) => Promise<{
  passed: boolean;
  attestation: LegAttestation;
}>;

/**
 * Run the LOCAL CI surface (`prx ci`: install→typecheck→docs→build→test) as a
 * gate, in the unit's worktree. Same shape as the remote CI gate — green
 * advances, red retreats to `executing` (budget-bounded). Signs
 * `<unit>:gate@checks-local`. See docs/prx/pipeline-local-checks.md.
 */
export type ChecksGate = CiGate;

/** Merge the PR (publisher actor) + sign the merge link. */
export type MergeRunner = (input: { workUnitId: string }) => Promise<{
  attestation: LegAttestation;
}>;

/**
 * GH-232: the intake leg — resolve the unit's source authority and pin it as the
 * chain ROOT `<unit>:source@pinned`, signed. Deterministic (no LLM), so it is a
 * plain seam like the CI gate / merge, not a `runLeg` subagent. Runs once at the
 * head of the pipeline so the planner CONSUMES a real source instead of
 * fabricating (the GH-230 failure mode); on failure the pilot blocks — no plan
 * without a source.
 */
export type IntakeRunner = (input: { workUnitId: string }) => Promise<{
  attestation: LegAttestation;
}>;

/** The injected dependencies. Only `runLeg` is required; the tail has defaults. */
export type PilotDeps = {
  runLeg: LegRunner;
  runIntake?: IntakeRunner;
  /** Local `prx ci` gate, between executing and testing. Defaults to auto-pass. */
  runChecks?: ChecksGate;
  runCiGate?: CiGate;
  runMerge?: MergeRunner;
  /** Signs the pilot summary statement with the pilot's authority. */
  signSummary?: StatementSigner;
  /**
   * Anchor the run's observability (heartbeat / seam telemetry) into the signed
   * summary WITHOUT gating: returns the hash-chain head over all telemetry for
   * the unit. Folded into the `prx.pilot/v1` predicate as `observed`, so the
   * pilot's existing signature commits to the telemetry stream (tamper-evident,
   * zero extra signatures). Returns null ⇒ no `observed` field. Health is never
   * a gate; see docs/prx/pipeline-local-checks.md.
   */
  observedAnchor?: (input: { workUnitId: string }) => { digest: string; count: number } | null;
};

export type PilotContext = {
  workUnitId: string;
  /** The ordered, signed provenance chain (in-toto steps). */
  chain: LegAttestation[];
  /** Termination fuel — every failure-retreat spends one; see `pilotMeasure`. */
  retreatBudget: number;
  /** The pilot's in-toto summary statement, minted in `sealing`. */
  summary?: Statement;
  lastError?: string;
};

export const DEFAULT_RETREAT_BUDGET = 3;

export type PilotInput = { workUnitId: string; retreatBudget?: number };

/** The pilot's machine output (read by the fleet on completion). */
export type PilotOutput = {
  workUnitId: string;
  chain: LegAttestation[];
  summary: Statement | null;
  lastError: string | null;
};

/**
 * Ordinal of each ACTIVE state (0 = furthest from merged). Halt states
 * (`merged`/`abandoned`/`blocked`) are unranked — no autonomous successor.
 */
export const pilotPhaseRank = {
  // GH-232: `intaking` is the new head (rank 0). It has no retreat edge — entered
  // once at start, never re-entered — so the well-founded measure is preserved
  // (forward intaking→planning strictly decreases distance; no new cycle).
  intaking: 0,
  planning: 1,
  executing: 2,
  // `checking` is the local `prx ci` gate; like `awaiting_ci` it retreats to
  // `executing` on red (budget ↓ dominates) and advances forward otherwise, so
  // the well-founded measure is preserved — no new cycle.
  checking: 3,
  testing: 4,
  reviewing: 5,
  awaiting_ci: 6,
  ready_to_merge: 7,
  sealing: 8,
} as const;
const MERGED_RANK = 9;

/**
 * Well-founded termination measure: lexicographic `[retreatBudget,
 * distanceToMerged] ∈ ℕ²`, `null` for halts.
 *
 * PROOF no action repeats forever: every autonomous transition strictly
 * decreases it, and ℕ² is well-founded.
 *   - forward (planning→…→sealing→merged): budget unchanged, distance ↓.
 *   - failure-retreat (executor / red-CI → executing): budget ↓ (dominates).
 *   - budget exhausted → `abandoned`; advance:false → `blocked` (halts).
 * Liveness caveat: `awaiting_ci` advances only when the CI gate RESOLVES —
 * pending never resolves (the hard block), so global liveness assumes CI
 * eventually settles. The fail-retry cycles are budget-bounded regardless.
 */
export function pilotMeasure(
  value: string,
  context: Pick<PilotContext, "retreatBudget">,
): [number, number] | null {
  if (value in pilotPhaseRank) {
    const rank = pilotPhaseRank[value as keyof typeof pilotPhaseRank];
    return [context.retreatBudget, MERGED_RANK - rank];
  }
  return null; // merged | abandoned | blocked
}

// ── default tail actors (auto-pass) — tests/demo override to exercise gates ──

const defaultCiGate: CiGate = ({ workUnitId }) =>
  Promise.resolve({
    passed: true,
    attestation: {
      stage: "ci",
      subject: `${workUnitId}:gate@ci-remote`,
      predicate: "ci.passed",
      signedBy: "remote_ci@stub",
      sig: "stub-ci-sig",
    },
  });

const defaultChecks: ChecksGate = ({ workUnitId }) =>
  Promise.resolve({
    passed: true,
    attestation: {
      stage: "checks",
      subject: `${workUnitId}:gate@checks-local`,
      predicate: "checks.passed",
      signedBy: "local_checks@stub",
      sig: "stub-checks-sig",
    },
  });

const defaultMerge: MergeRunner = ({ workUnitId }) =>
  Promise.resolve({
    attestation: {
      stage: "merge",
      subject: `${workUnitId}:merged@pr`,
      predicate: "pr.merged",
      signedBy: "publisher@stub",
      sig: "stub-merge-sig",
    },
  });

const defaultIntake: IntakeRunner = ({ workUnitId }) =>
  Promise.resolve({
    attestation: {
      stage: "intake",
      subject: `${workUnitId}:source@pinned`,
      predicate: "source.pinned",
      signedBy: "intake@stub",
      sig: "stub-intake-sig",
    },
  });

/**
 * Build the Layer-1 pilot machine. The deps are the seams; swap them to change
 * HOW legs / CI / merge run without touching the pipeline shape.
 */
export function createPilotMachine(deps: PilotDeps | LegRunner) {
  // Accept a bare LegRunner for the common case (tail uses defaults).
  const d: PilotDeps = typeof deps === "function" ? { runLeg: deps } : deps;
  const runLeg = d.runLeg;
  const intakeRunner = d.runIntake ?? defaultIntake;
  const checksGate = d.runChecks ?? defaultChecks;
  const ciGate = d.runCiGate ?? defaultCiGate;
  const mergeRunner = d.runMerge ?? defaultMerge;
  const signSummary = d.signSummary ?? stubStatementSigner("pilot");
  const observedAnchor = d.observedAnchor ?? (() => null);

  return setup({
    types: {
      context: {} as PilotContext,
      input: {} as PilotInput,
      output: {} as PilotOutput,
    },
    actors: {
      runLeg: fromPromise<LegResult, LegInput>(({ input }) => runLeg(input)),
      runIntake: fromPromise<{ attestation: LegAttestation }, { workUnitId: string }>(({ input }) =>
        intakeRunner(input),
      ),
      runChecks: fromPromise<
        { passed: boolean; attestation: LegAttestation },
        { workUnitId: string }
      >(({ input }) => checksGate(input)),
      runCiGate: fromPromise<
        { passed: boolean; attestation: LegAttestation },
        { workUnitId: string }
      >(({ input }) => ciGate(input)),
      runMerge: fromPromise<{ attestation: LegAttestation }, { workUnitId: string }>(({ input }) =>
        mergeRunner(input),
      ),
      // Mints the pilot's own in-toto artifact over the whole signed chain.
      sealSummary: fromPromise<Statement, { workUnitId: string; chain: LegAttestation[] }>(
        ({ input }) => {
          // Anchor observability into the signed summary (never a gate): the
          // telemetry hash-chain head rides along, so the pilot's signature
          // commits to it. Absent ⇒ no `observed` field (back-compatible).
          const observed = observedAnchor({ workUnitId: input.workUnitId });
          return buildStatement(signSummary, {
            predicateType: "prx.pilot/v1",
            subject: [{ name: input.workUnitId, digest: { sha256: digestOf(input.chain) } }],
            predicate: {
              legCount: input.chain.length,
              steps: input.chain.map((l) => ({
                stage: l.stage,
                subject: l.subject,
                predicate: l.predicate,
                signedBy: l.signedBy,
                digest: digestOf(l),
              })),
              ...(observed ? { observed: { digest: observed.digest, count: observed.count } } : {}),
            },
          });
        },
      ),
    },
    guards: {
      didAdvance: (_a, params: { result: LegResult }) => params.result.advance,
      ciPassed: (_a, params: { passed: boolean }) => params.passed,
      canRetreat: ({ context }: { context: PilotContext }) => context.retreatBudget > 0,
    },
    actions: {
      pushLink: (
        { context }: { context: PilotContext },
        params: { attestation: LegAttestation },
      ) => {
        context.chain.push(params.attestation);
      },
      spendRetreat: ({ context }: { context: PilotContext }) => {
        context.retreatBudget -= 1;
      },
      setSummary: ({ context }: { context: PilotContext }, params: { summary: Statement }) => {
        context.summary = params.summary;
      },
      recordError: ({ context }: { context: PilotContext }, params: { error: unknown }) => {
        context.lastError = String((params.error as Error)?.message ?? params.error);
      },
    },
  }).createMachine({
    id: "pilot",
    initial: "intaking",
    context: ({ input }) => ({
      workUnitId: input.workUnitId,
      chain: [],
      retreatBudget: input.retreatBudget ?? DEFAULT_RETREAT_BUDGET,
    }),
    output: ({ context }) => ({
      workUnitId: context.workUnitId,
      chain: context.chain,
      summary: context.summary ?? null,
      lastError: context.lastError ?? null,
    }),
    states: {
      // GH-232: pin the chain ROOT before any planning. Deterministic, runs once.
      // Success pushes `source@pinned` and advances to planning; failure BLOCKS
      // (no source ⇒ no plan — the planner must never fabricate). No retreat edge
      // here, so the well-founded termination measure is preserved.
      intaking: {
        invoke: {
          src: "runIntake" as const,
          input: ({ context }: { context: PilotContext }) => ({ workUnitId: context.workUnitId }),
          onDone: {
            target: "planning",
            actions: {
              type: "pushLink" as const,
              params: ({ event }: { event: { output: { attestation: LegAttestation } } }) => ({
                attestation: event.output.attestation,
              }),
            },
          },
          onError: {
            target: "blocked",
            actions: {
              type: "recordError" as const,
              params: ({ event }: { event: { error: unknown } }) => ({ error: event.error }),
            },
          },
        },
      },
      planning: legState("planner", "executing", "planning"),
      executing: legState("executor", "checking", "planning"),

      // Local `prx ci` gate (GH: see docs/prx/pipeline-local-checks.md). Green →
      // testing; red → retreat to executing to fix (budget-bounded). Fails fast
      // on the real CI surface BEFORE the LLM tester/reviewer legs + remote CI.
      checking: gateState("runChecks", "testing", "executing"),

      testing: legState("tester", "reviewing", "executing"),
      reviewing: legState("reviewer", "awaiting_ci", "executing"),

      // HARD BLOCK: the only path toward merge. Advances solely on settled-green.
      awaiting_ci: gateState("runCiGate", "ready_to_merge", "executing"),

      ready_to_merge: {
        invoke: {
          src: "runMerge",
          input: ({ context }: { context: PilotContext }) => ({ workUnitId: context.workUnitId }),
          onDone: {
            target: "sealing",
            actions: {
              type: "pushLink" as const,
              params: ({ event }: { event: { output: { attestation: LegAttestation } } }) => ({
                attestation: event.output.attestation,
              }),
            },
          },
          onError: {
            target: "blocked",
            actions: {
              type: "recordError" as const,
              params: ({ event }: { event: { error: unknown } }) => ({ error: event.error }),
            },
          },
        },
      },

      // Mint the pilot's in-toto summary statement, then the unit is merged.
      sealing: {
        invoke: {
          src: "sealSummary",
          input: ({ context }: { context: PilotContext }) => ({
            workUnitId: context.workUnitId,
            chain: context.chain,
          }),
          onDone: {
            target: "merged",
            actions: {
              type: "setSummary" as const,
              params: ({ event }: { event: { output: Statement } }) => ({ summary: event.output }),
            },
          },
          onError: {
            target: "blocked",
            actions: {
              type: "recordError" as const,
              params: ({ event }: { event: { error: unknown } }) => ({ error: event.error }),
            },
          },
        },
      },

      blocked: {
        on: {
          RETRY_PLANNER: "planning",
          RETRY_EXECUTOR: "executing",
          RETRY_TESTER: "testing",
          RETRY_REVIEWER: "reviewing",
        },
      },
      abandoned: { type: "final" },
      merged: { type: "final" },
    },
  });

  /** A role-leg state: invoke the subagent, sign, advance / block / retreat. */
  function legState(role: TaskRole, onAdvance: string, onError: string) {
    return {
      invoke: {
        src: "runLeg" as const,
        input: ({ context }: { context: PilotContext }): LegInput => ({
          role,
          profile: roleProfile[role],
          workUnitId: context.workUnitId,
        }),
        onDone: [
          {
            guard: {
              type: "didAdvance" as const,
              params: ({ event }: { event: { output: LegResult } }) => ({ result: event.output }),
            },
            target: onAdvance,
            actions: {
              type: "pushLink" as const,
              params: ({ event }: { event: { output: LegResult } }) => ({
                attestation: event.output.attestation,
              }),
            },
          },
          {
            target: "blocked",
            actions: {
              type: "pushLink" as const,
              params: ({ event }: { event: { output: LegResult } }) => ({
                attestation: event.output.attestation,
              }),
            },
          },
        ],
        onError: legRetreat(onError),
      },
    };
  }

  /**
   * A deterministic GATE state: invoke a pass/fail seam, sign its link, then
   * advance on pass / retreat to `onRetreat` on red (budget-bounded) / abandon
   * when the budget is spent. Shared by `checking` (local `prx ci`) and
   * `awaiting_ci` (remote CI) — same shape, different seam + forward target.
   */
  function gateState(src: "runChecks" | "runCiGate", onPass: string, onRetreat: string) {
    const pushAttestation = {
      type: "pushLink" as const,
      params: ({ event }: { event: { output: { attestation: LegAttestation } } }) => ({
        attestation: event.output.attestation,
      }),
    };
    return {
      invoke: {
        src,
        input: ({ context }: { context: PilotContext }) => ({ workUnitId: context.workUnitId }),
        onDone: [
          {
            guard: {
              type: "ciPassed" as const,
              params: ({ event }: { event: { output: { passed: boolean } } }) => ({
                passed: event.output.passed,
              }),
            },
            target: onPass,
            actions: pushAttestation,
          },
          {
            // red, budget left → retreat to fix.
            guard: "canRetreat" as const,
            target: onRetreat,
            actions: [pushAttestation, { type: "spendRetreat" as const }],
          },
          {
            // red, no budget → abandon (still record the failed gate).
            target: "abandoned",
            actions: pushAttestation,
          },
        ],
        onError: legRetreat(onRetreat),
      },
    };
  }

  /** onError for a leg: retreat to `onError` while budgeted, else abandon. */
  function legRetreat(onError: string) {
    return [
      {
        guard: "canRetreat" as const,
        target: onError,
        actions: [
          { type: "spendRetreat" as const },
          {
            type: "recordError" as const,
            params: ({ event }: { event: { error: unknown } }) => ({ error: event.error }),
          },
        ],
      },
      {
        target: "abandoned",
        actions: {
          type: "recordError" as const,
          params: ({ event }: { event: { error: unknown } }) => ({ error: event.error }),
        },
      },
    ];
  }
}

/** Test/demo leg runner — instant signed link, advance. */
export const stubLegRunner: LegRunner = (input) =>
  Promise.resolve({
    role: input.role,
    advance: true,
    attestation: {
      stage: input.role,
      subject: `${input.workUnitId}:${input.profile.signs}`,
      predicate: `${input.role}.completed`,
      signedBy: `${input.role}@stub`,
      sig: "stub-signature",
    },
  });
