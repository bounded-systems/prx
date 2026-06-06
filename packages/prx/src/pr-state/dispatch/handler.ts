// Dispatch handler (GH-1194). Wires the parsed argv envelope to the XState
// dispatch machine with real subprocess + CAS actors. Prints the CAS handle
// (`<target>://sha256:...`) on stdout when the target verb succeeds; exits
// with a non-zero code carrying the failure reason when the capability /
// depth guard or the target verb itself fails.

import { processEnv } from "@bounded-systems/env";
import { streamCapture } from "@bounded-systems/proc";
import { randomBytes } from "node:crypto";
import { fromPromise, createActor } from "xstate";

import {
  DISPATCH_DEPTH_ENV,
  DISPATCH_PARENT_ENV,
  DISPATCH_SOURCE_ENV,
  type DispatchActor,
  type DispatchFailure,
  type DispatchResult,
  readDispatchDepth,
  readTypedDispatchFlag,
} from "../../machine/dispatch.ts";
import { getAgentContract } from "../../machine/contracts/instances.ts";
import {
  createDispatchMachine,
  isDispatchSuccess,
  type DispatchMachineInput,
  type InvokeTargetVerbInput,
  type InvokeTargetVerbOutput,
  type WriteCasBlobInput,
  type WriteCasBlobOutput,
} from "../../machine/machines/dispatch.ts";
import { setRef, writeBlob } from "../../plan-store/cas.ts";
import { SESSION_PROFILES } from "../../machine/runtime_profiles.ts";
import { actorSpecFor } from "../../cli/registry.data.ts";
import type { ParsedDispatch } from "./parse.ts";

export interface DispatchRunInput {
  parsed: ParsedDispatch;
  /** Pre-resolved environment; defaults to processEnv(). */
  env?: NodeJS.ProcessEnv;
  /** Path to the `prx` executable to invoke for cross-actor subprocess. */
  prxBinary?: string;
}

export interface DispatchRunOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const DEFAULT_PRX_BINARY = "prx";

/**
 * GH-1530 PR-6 (target-authoritative ocap flip): resolve the TARGET's inbound
 * capability — the callers it admits — from the ActorSpec registry. Injected
 * into `canDispatch` as `allowedCallers`, which is now the sole cross-actor
 * authority (the caller-side outbound gate was retired). A non-dispatchable
 * target resolves to an empty list (admits no caller).
 */
function resolveAllowedCallers(
  target: DispatchActor,
): readonly DispatchActor[] {
  return actorSpecFor(target).allowedCallers;
}

/**
 * GH-2418 — resolve whether the OCAP (typed-input) gate is on for this
 * dispatch. Per-profile config wins: a session-profile source that sets
 * `typedDispatchRejection: true` (today: `implement`) is gated regardless of
 * the env flag. Any other source falls back to the global
 * `PRX_TYPED_DISPATCH_REJECTION` env flag (default off), preserving
 * backwards-compatibility for plan/triage/intake/etc.
 */
function resolveRejectUntyped(
  source: DispatchActor,
  env: NodeJS.ProcessEnv,
): boolean {
  if (
    source === "plan" ||
    source === "intake" ||
    source === "triage" ||
    source === "implement" ||
    source === "submit" ||
    source === "author"
  ) {
    if (SESSION_PROFILES[source].typedDispatchRejection === true) return true;
  }
  return readTypedDispatchFlag(env);
}

/**
 * Invoke a dispatched target verb in a subprocess. The subprocess inherits
 * the dispatch-depth env so nested dispatches see the correct depth, and
 * stdout is captured into a single Buffer for CAS storage.
 */
/**
 * The env handed to the target's subprocess: the parent env plus the dispatch
 * propagation vars. Pure + exported so the propagation contract is unit-testable
 * without spawning. GH-352 adds `DISPATCH_SOURCE_ENV` so the child attributes
 * provenance to the dispatching source's authority.
 */
export function dispatchChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  opts: { childDepth: number; parentDispatchId: string; source: DispatchActor },
): NodeJS.ProcessEnv {
  return {
    ...parentEnv,
    [DISPATCH_DEPTH_ENV]: String(opts.childDepth),
    [DISPATCH_PARENT_ENV]: opts.parentDispatchId,
    [DISPATCH_SOURCE_ENV]: opts.source,
  };
}

function buildInvokeActor(opts: {
  prxBinary: string;
  parentEnv: NodeJS.ProcessEnv;
  parentDispatchId: string;
  source: DispatchActor;
}) {
  return fromPromise<InvokeTargetVerbOutput, InvokeTargetVerbInput>(
    async ({ input }) => {
      const start = Date.now();
      const childEnv = dispatchChildEnv(opts.parentEnv, {
        childDepth: input.childDepth,
        parentDispatchId: opts.parentDispatchId,
        source: opts.source,
      });
      // The dispatched verb is invoked as a top-level prx command. The argv
      // shape is the target's namespaced verb (e.g. `prx scout grep …`); we
      // pass the action through verbatim to preserve the target's existing
      // argv parser. `args` is the argv tail.
      const argv: string[] = [
        input.target,
        input.action,
        ...((input.args.argv as string[] | undefined) ?? []),
      ];
      // streamCapture wires stdin=ignore, stdout/stderr=pipe (matching the
      // prior stdio) and temp-file-backs stdout so large target output has no
      // in-memory ceiling. It reports a spawn failure via result.error rather
      // than rejecting, so re-throw it to keep this actor's reject contract.
      const result = await streamCapture([opts.prxBinary, ...argv], {
        env: childEnv,
      });
      if (result.error) {
        throw result.error;
      }
      const exitCode = result.status ?? 1;
      if (exitCode !== 0) {
        throw new Error(
          `dispatch target ${input.target} ${input.action} exited ${exitCode}: ${result.stderr.trim()}`,
        );
      }
      return {
        stdout: Buffer.from(result.stdout, "utf8"),
        exitCode,
        durationMs: Date.now() - start,
      };
    },
  );
}

/**
 * Persist the captured stdout into the target actor's CAS domain and set a
 * ref under `dispatch:<source>:<id>` so audit/teardown lookups can resolve
 * the blob without re-reading argv state.
 */
function buildWriteCasActor(opts: { dispatchId: string }) {
  return fromPromise<WriteCasBlobOutput, WriteCasBlobInput>(async ({ input }) => {
    const { sha } = await writeBlob(input.stdout, { domain: input.target });
    const refName = `dispatch:${input.source}:${opts.dispatchId}`;
    await setRef(refName, sha, { domain: input.target });
    return { sha, refName };
  });
}

function makeDispatchId(): string {
  // Short opaque id: 4 random bytes hex, scoped per-run. Refs use this in
  // `dispatch:<source>:<id>` so multiple parallel dispatches do not collide.
  return randomBytes(4).toString("hex");
}

export interface RunDispatchOptions {
  parsed: ParsedDispatch;
  env?: NodeJS.ProcessEnv;
  prxBinary?: string;
  /** Override for tests: stub invoke + writeCas actors. */
  actors?: {
    invokeTargetVerb?: ReturnType<typeof buildInvokeActor>;
    writeCasBlob?: ReturnType<typeof buildWriteCasActor>;
  };
}

export interface RunDispatchResult {
  outcome: DispatchResult | DispatchFailure;
  /** Final state value: "done" | "failed". */
  state: string;
}

export async function runDispatch(
  opts: RunDispatchOptions,
): Promise<RunDispatchResult> {
  const env = opts.env ?? processEnv();
  const dispatchId = makeDispatchId();
  const prxBinary = opts.prxBinary ?? DEFAULT_PRX_BINARY;
  const depth = readDispatchDepth(env);

  const invokeTargetVerb =
    opts.actors?.invokeTargetVerb ??
    buildInvokeActor({
      prxBinary,
      parentEnv: env,
      parentDispatchId: env[DISPATCH_PARENT_ENV] ?? dispatchId,
      source: opts.parsed.source,
    });
  const writeCasBlob =
    opts.actors?.writeCasBlob ?? buildWriteCasActor({ dispatchId });

  const machine = createDispatchMachine({
    invokeTargetVerb,
    writeCasBlob,
  });

  // GH-2418: the OCAP gate inputs. `expectedInputType` is the target's
  // contract-declared input artifact (null when the target has no contract);
  // `rejectUntyped` is the per-profile/env flip; `inputArtifact` is the typed
  // capability the caller presented on the argv.
  const expectedInputType =
    getAgentContract(opts.parsed.target)?.inputArtifact ?? null;
  const rejectUntyped = resolveRejectUntyped(opts.parsed.source, env);

  const input: DispatchMachineInput = {
    source: opts.parsed.source,
    target: opts.parsed.target,
    action: opts.parsed.action,
    args: { argv: opts.parsed.argv },
    // exactOptionalPropertyTypes: omit the key when the env var is unset
    // rather than threading an explicit `undefined` into the Zod-inferred input.
    ...(env[DISPATCH_PARENT_ENV] !== undefined
      ? { parentDispatchId: env[DISPATCH_PARENT_ENV] }
      : {}),
    ...(opts.parsed.inputArtifact !== undefined
      ? { inputArtifact: opts.parsed.inputArtifact }
      : {}),
    depth,
    allowedCallers: resolveAllowedCallers(opts.parsed.target),
    rejectUntyped,
    expectedInputType,
  };

  return await new Promise<RunDispatchResult>((resolve, reject) => {
    const actor = createActor(machine, { input });
    actor.subscribe({
      complete: () => {
        const snap = actor.getSnapshot();
        const output = snap.output as DispatchResult | DispatchFailure | undefined;
        if (output === undefined) {
          reject(new Error("dispatch machine completed without output"));
          return;
        }
        resolve({ outcome: output, state: String(snap.value) });
      },
      error: reject,
    });
    actor.start();
  });
}

/**
 * Map a dispatch outcome to (stdout, stderr, exitCode) for the CLI handler.
 * Success emits `<casHandle>\n` to stdout. Failure emits the reason+detail
 * to stderr and uses a fixed exit code per failure class.
 */
export function renderDispatchOutcome(
  outcome: DispatchResult | DispatchFailure,
): { stdout: string; stderr: string; exitCode: number } {
  if (isDispatchSuccess(outcome)) {
    return { stdout: `${outcome.casHandle}\n`, stderr: "", exitCode: 0 };
  }
  // Failure-reason exit code map. 64 = capability/argv issue (sysexits.h
  // EX_USAGE), 65 = data error (depth/execution), 70 = software error
  // (unknown). These are stable enough for shell scripting around dispatch.
  const exitCode =
    outcome.reason === "capability_denied" || outcome.reason === "actor_unknown" || outcome.reason === "verb_unknown"
      ? 64
      : outcome.reason === "depth_exceeded" || outcome.reason === "execution_failed"
        ? 65
        : 70;
  return {
    stdout: "",
    stderr: `dispatch ${outcome.reason}: ${outcome.detail}\n`,
    exitCode,
  };
}
