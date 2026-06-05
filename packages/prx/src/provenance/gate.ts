/**
 * The Gate framework (prx-tth, epic prx-9zh).
 *
 * A *gate* is a verification-tier actor with one uniform contract:
 *
 *   gate(input artifact) → run a check → emit a typed CAS verdict artifact
 *                                       + a signed in-toto `gate/v1` attestation
 *
 * It generalizes the inline, ad-hoc verification the orchestrator used to do by
 * hand (diff-scope check, running skipped tests, watching CI) into a first-class
 * actor that leaves *durable, signed* evidence. The whole attestation stack is
 * reused unchanged from the `commit/v1` / `checks/v1` / `push/v1` path
 * ({@link persistAttestation} → {@link slsaProvenanceStatement} → DSSE sign →
 * ledger append); a gate adds nothing cryptographic.
 *
 * Two design decisions baked in here:
 *   1. ONE generic predicate `https://prx.dev/gate/v1`. The specific gate is a
 *      `gate` name field in the params, not a distinct predicateType — so a
 *      single verifier reads every gate and adding a gate needs no new type.
 *   2. ALWAYS emit a signed verdict. Unlike {@link attestingProc} (which signs
 *      only on success), {@link runGate} calls {@link persistAttestation}
 *      unconditionally: a *failed* gate is signed evidence too. The pass/fail
 *      lives in the attestation `externalParameters` AND in the CAS verdict
 *      artifact, so a downstream actor gates on `verdict == "pass"`.
 *
 * `runGate` is the single helper every concrete gate (`scope-gate`, and the
 * follow-up `test-gate` / `ci-gate`) calls — they differ only in the check that
 * decides `pass`/`violations` and the subject they attest over.
 */
import { z } from "zod";

import {
  type ArtifactEdge,
  defineEdge,
  emitArtifact,
} from "../pipeline/edge.ts";
import { type AttestDeps, persistAttestation } from "./attest.ts";

/** The single in-toto predicate type every gate verdict is attested under. */
export const GATE_BUILD_TYPE = "https://prx.dev/gate/v1";

/**
 * A gate's verdict, pinned to `<unit>:gate@<gateName>` in the CAS. It carries
 * the machine-checkable outcome (`pass` + `violations`) and a back-reference to
 * the signed `gate/v1` attestation (`attestation` = its `derivationId`), so a
 * consumer can resolve and verify the DSSE envelope from the ledger.
 */
export const gateVerdictSchema = z.object({
  /** The work unit gated. */
  unit: z.string().min(1),
  /** Which gate produced this (e.g. `scope`, `test`, `ci`). */
  gate: z.string().min(1),
  /** The verdict: did the check pass? */
  pass: z.boolean(),
  /** The specific reasons the gate failed (empty ⇒ pass). */
  violations: z.array(z.string()),
  /** Optional human-readable summary of the verdict. */
  reason: z.string().optional(),
  /** The git commit oid the verdict is about (the attestation subject). */
  subject: z.string().min(1),
  /** The `derivationId` of the signed `gate/v1` attestation in the ledger. */
  attestation: z.string().min(1),
  /** ISO-8601 emission time (from the injected clock). */
  createdAt: z.string().min(1),
});
export type GateVerdict = z.infer<typeof gateVerdictSchema>;

/**
 * The verdict edge for a named gate: the gate actor emits `<unit>:gate@<gate>`;
 * `submit` (and the publisher tier) consume it as a precondition.
 */
export function gateVerdictEdge(gate: string): ArtifactEdge<GateVerdict> {
  return defineEdge({
    kind: "gate",
    slot: gate,
    source: `${gate}-gate`,
    target: "submit",
    schema: gateVerdictSchema,
  });
}

export interface RunGateInput {
  /** The work unit being gated. */
  readonly unit: string;
  /** The gate name — the `gate` field and the verdict slot (`gate@<gate>`). */
  readonly gate: string;
  /** The git commit oid the verdict is about (the in-toto subject). */
  readonly subjectCommit: string;
  /** Whether the check passed. */
  readonly pass: boolean;
  /** The reasons it failed (empty ⇒ pass). */
  readonly violations: readonly string[];
  /** Optional human-readable verdict summary, recorded on the artifact + params. */
  readonly reason?: string;
  /** Extra gate-specific params folded into the attestation `externalParameters`. */
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface GateResult {
  readonly pass: boolean;
  readonly gate: string;
  /** The `<unit>:gate@<gate>` ref the verdict artifact was pinned to. */
  readonly ref: string;
  /** The signed attestation's `derivationId` (its ledger identity). */
  readonly derivationId: string;
  readonly verdict: GateVerdict;
}

/**
 * Run a gate's emission half: sign a `gate/v1` attestation over `subjectCommit`
 * (always — pass OR fail) and pin the typed verdict artifact. The *check* that
 * decides `pass`/`violations` belongs to the concrete gate; this is the shared
 * sign-and-emit every gate funnels through.
 */
export async function runGate(
  input: RunGateInput,
  deps: AttestDeps,
): Promise<GateResult> {
  const verdict = input.pass ? "pass" : "fail";
  const derivation = await persistAttestation(deps, {
    buildType: GATE_BUILD_TYPE,
    subject: [{ name: input.gate, digest: { gitCommit: input.subjectCommit } }],
    externalParameters: {
      gate: input.gate,
      verdict,
      violations: [...input.violations],
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.params ?? {}),
    },
  });
  const derivationId = String(derivation.derivationId);
  const createdAt = new Date((deps.now ?? Date.now)()).toISOString();

  const record: GateVerdict = {
    unit: input.unit,
    gate: input.gate,
    pass: input.pass,
    violations: [...input.violations],
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    subject: input.subjectCommit,
    attestation: derivationId,
    createdAt,
  };
  const { ref } = await emitArtifact(gateVerdictEdge(input.gate), input.unit, record);
  return { pass: input.pass, gate: input.gate, ref, derivationId, verdict: record };
}
