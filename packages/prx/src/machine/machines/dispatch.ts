// Dispatch child machine (GH-1194). Drives one bounded headless verb on a
// target actor and writes its captured output to the CAS substrate. Output
// is a CAS handle (e.g. `scout://sha256:...`) the parent re-reads on demand.
//
// Lifecycle:
//   idle → DISPATCH_REQUESTED → validating
//   validating  ──[guard:capabilityAllowed ∧ depthOk]──→ invoking
//   validating  ──[else]──────────────────────────────→ failed
//   invoking    ──[onDone]──→ writingCas
//   invoking    ──[onError]─→ failed
//   writingCas  ──[onDone]──→ done
//   writingCas  ──[onError]─→ failed
//
// The invoke + writeCas actors are injected by the caller so the machine
// stays pure and testable. Production wiring (subprocess execution, real
// CAS writes) lives in src/pr-state/dispatch/handler.ts (sub-ticket C).
//
// Per memory `reference_zod_boundary_layer`, Zod sits at the boundary
// (dispatchRequestSchema/dispatchResultSchema in src/machine/dispatch.ts);
// the machine itself uses TypeScript types derived from those schemas.

import { assign, fromPromise, setup } from "xstate";

import {
  type DispatchActor,
  type DispatchFailureReason,
  type DispatchRequest,
  type DispatchResult,
  assertTypedInputArtifact,
  canDispatch,
  casUriFor,
} from "../dispatch.ts";
import type { CasSha } from "../../plan-store/cas.ts";

// ── actor I/O contracts ────────────────────────────────────────────────────

export interface InvokeTargetVerbInput {
  target: DispatchActor;
  action: string;
  args: Record<string, unknown>;
  /** Depth of the spawned subprocess; nested dispatches use depth+1. */
  childDepth: number;
}

export interface InvokeTargetVerbOutput {
  /** Bytes captured from the target verb's stdout. */
  stdout: Buffer;
  exitCode: number;
  durationMs: number;
}

export type InvokeTargetVerbActor = ReturnType<
  typeof fromPromise<InvokeTargetVerbOutput, InvokeTargetVerbInput>
>;

export interface WriteCasBlobInput {
  target: DispatchActor;
  source: DispatchActor;
  parentDispatchId: string | undefined;
  stdout: Buffer;
}

export interface WriteCasBlobOutput {
  sha: CasSha;
  /** Ref name set as a side-effect, for audit/teardown lookups. */
  refName: string;
}

export type WriteCasBlobActor = ReturnType<
  typeof fromPromise<WriteCasBlobOutput, WriteCasBlobInput>
>;

// ── machine input + context ────────────────────────────────────────────────

export interface DispatchMachineInput extends DispatchRequest {
  /** Current dispatch nesting depth (0 = top-level). */
  depth: number;
  /**
   * GH-1530 PR-6: target-side inbound capability — the callers the TARGET
   * admits, resolved from `actorSpecFor(target).allowedCallers`. This is the
   * sole cross-actor dispatch authority (target-authoritative); the CLI handler
   * injects it from the ActorSpec registry. Omitted ⇒ empty set (deny-by-default).
   */
  allowedCallers?: readonly DispatchActor[] | undefined;
  /**
   * GH-2418 — the OCAP gate. When `true`, the dispatch is denied unless the
   * request carries an `inputArtifact` whose `type` matches the target's
   * `AgentContract.inputArtifact` (`expectedInputType`). The CLI handler
   * derives this per-profile (`SESSION_PROFILES[source].typedDispatchRejection`)
   * falling back to the `PRX_TYPED_DISPATCH_REJECTION` env flag. Defaults to
   * `false` so existing callers stay backwards-compatible.
   */
  rejectUntyped?: boolean;
  /**
   * GH-2418 — the target's declared input-artifact type
   * (`AgentContract.inputArtifact`), or `null` when the target has no
   * contract-declared input. When `null`, the OCAP gate short-circuits to
   * allow regardless of `rejectUntyped`.
   */
  expectedInputType?: string | null;
}

export interface DispatchFailure {
  reason: DispatchFailureReason;
  detail: string;
}

export interface DispatchMachineContext {
  request: DispatchRequest;
  depth: number;
  allowedCallers: readonly DispatchActor[] | undefined;
  /** GH-2418 — OCAP gate: deny when typed input is required but absent/mismatched. */
  rejectUntyped: boolean;
  /** GH-2418 — target's `AgentContract.inputArtifact`, or null when uncontracted. */
  expectedInputType: string | null;
  invokeOutput: InvokeTargetVerbOutput | null;
  writeOutput: WriteCasBlobOutput | null;
  failure: DispatchFailure | null;
}

const initialDispatchContext = (input: DispatchMachineInput): DispatchMachineContext => ({
  request: {
    source: input.source,
    target: input.target,
    action: input.action,
    args: input.args ?? {},
    // exactOptionalPropertyTypes: only attach the optional keys when present
    // so an explicit `undefined` is never threaded into the Zod-typed request.
    ...(input.parentDispatchId !== undefined ? { parentDispatchId: input.parentDispatchId } : {}),
    ...(input.inputArtifact !== undefined ? { inputArtifact: input.inputArtifact } : {}),
  },
  depth: input.depth,
  allowedCallers: input.allowedCallers,
  rejectUntyped: input.rejectUntyped ?? false,
  expectedInputType: input.expectedInputType ?? null,
  invokeOutput: null,
  writeOutput: null,
  failure: null,
});

// ── combined dispatch verdict (role ACL + OCAP) ────────────────────────────
// GH-2418: the live gate is two checks in sequence. `canDispatch` is the
// coarse role-name ACL backstop; `assertTypedInputArtifact` is the OCAP
// (artifact-possession) gate — authority is held iff the caller carries an
// input artifact of the target contract's declared type. The role ACL runs
// first (cheaper, and an unknown actor has no meaningful contract); the OCAP
// check runs only once the ACL passes.
function evaluateDispatch(
  context: DispatchMachineContext,
): { ok: true } | { ok: false; reason: DispatchFailureReason; detail: string } {
  const capVerdict = canDispatch({
    source: context.request.source,
    target: context.request.target,
    action: context.request.action,
    allowedCallers: context.allowedCallers,
    depth: context.depth,
  });
  if (!capVerdict.ok) return capVerdict;
  return assertTypedInputArtifact({
    request: context.request,
    expectedInputType: context.expectedInputType,
    rejectUntyped: context.rejectUntyped,
  });
}

// ── machine factory ────────────────────────────────────────────────────────
// Actors are injected so the machine stays unit-testable without spawning
// subprocesses or touching disk. CLI wiring (sub-ticket C) constructs real
// actors over execFile + writeBlob/setRef.

export interface CreateDispatchMachineOptions {
  invokeTargetVerb: InvokeTargetVerbActor;
  writeCasBlob: WriteCasBlobActor;
}

export function createDispatchMachine(opts: CreateDispatchMachineOptions) {
  return setup({
    types: {
      context: {} as DispatchMachineContext,
      input: {} as DispatchMachineInput,
      output: {} as DispatchResult | DispatchFailure,
    },
    actors: {
      invokeTargetVerb: opts.invokeTargetVerb,
      writeCasBlob: opts.writeCasBlob,
    },
    guards: {
      // GH-2418: the live gate is role ACL ∧ OCAP (typed-input possession).
      // GH-1530 threads the target-owned `allowedCallers` into the role-ACL
      // half via `evaluateDispatch` → `canDispatch`.
      dispatchAllowed: ({ context }) => evaluateDispatch(context).ok,
    },
  }).createMachine({
    id: "dispatch",
    initial: "validating",
    context: ({ input }) => initialDispatchContext(input),
    states: {
      validating: {
        always: [
          { target: "invoking", guard: "dispatchAllowed" },
          {
            target: "failed",
            actions: assign({
              failure: ({ context }) => {
                const verdict = evaluateDispatch(context);
                if (verdict.ok) {
                  return {
                    reason: "execution_failed" as const,
                    detail: "guard verdict drift",
                  };
                }
                return { reason: verdict.reason, detail: verdict.detail };
              },
            }),
          },
        ],
      },
      invoking: {
        invoke: {
          id: "invokeTargetVerb",
          src: "invokeTargetVerb",
          input: ({ context }) => ({
            target: context.request.target,
            action: context.request.action,
            args: context.request.args,
            childDepth: context.depth + 1,
          }),
          onDone: {
            target: "writingCas",
            actions: assign({
              invokeOutput: ({ event }) => event.output,
            }),
          },
          onError: {
            target: "failed",
            actions: assign({
              failure: ({ event }) => ({
                reason: "execution_failed" as const,
                detail: event.error instanceof Error ? event.error.message : String(event.error),
              }),
            }),
          },
        },
      },
      writingCas: {
        invoke: {
          id: "writeCasBlob",
          src: "writeCasBlob",
          input: ({ context }) => ({
            source: context.request.source,
            target: context.request.target,
            parentDispatchId: context.request.parentDispatchId,
            stdout: context.invokeOutput?.stdout ?? Buffer.alloc(0),
          }),
          onDone: {
            target: "done",
            actions: assign({
              writeOutput: ({ event }) => event.output,
            }),
          },
          onError: {
            target: "failed",
            actions: assign({
              failure: ({ event }) => ({
                reason: "execution_failed" as const,
                detail: event.error instanceof Error ? event.error.message : String(event.error),
              }),
            }),
          },
        },
      },
      done: {
        type: "final",
      },
      failed: {
        type: "final",
      },
    },
    output: ({ context }): DispatchResult | DispatchFailure => {
      if (
        context.invokeOutput !== null &&
        context.writeOutput !== null &&
        context.failure === null
      ) {
        return {
          casHandle: casUriFor(context.request.target, context.writeOutput.sha),
          target: context.request.target,
          exitCode: context.invokeOutput.exitCode,
          durationMs: context.invokeOutput.durationMs,
        };
      }
      return (
        context.failure ?? {
          reason: "execution_failed",
          detail: "machine reached final without populating result",
        }
      );
    },
  });
}

export function isDispatchSuccess(
  output: DispatchResult | DispatchFailure,
): output is DispatchResult {
  return "casHandle" in output;
}
