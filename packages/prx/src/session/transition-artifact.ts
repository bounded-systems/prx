// ai-home-wlw5l — the deterministic spine of the agent-run posture's exit gate.
//
// "Validate the object, then pin it." A run's typed transition artifact (the
// content the agent emitted into its single sanctioned slot) is schema-validated
// against the role's `outputArtifact` type and, ONLY if valid, written to CAS
// outside the session as a pinnable `<domain>://sha256:<hex>` handle.
//
// The load-bearing distinction (operator steer 2026-05-30): telling the agent
// the schema (`--json-schema` / prompt) is the INSTRUMENT; the emitted object
// being schema-valid is the FINDING. Conflating them is the `/goal` collapse.
// So this validates the actual bytes deterministically — independent of what the
// run was instructed to produce — and an invalid object never becomes a handle.
//
// This is the reusable core consumed by the Stop-hook exit gate (the next slice:
// a `command` Stop hook that reads the slot, calls this, persists to CAS, and
// blocks termination when the slot is empty/invalid) and by any headless run
// that pins its `--json-schema` output. The schema + CAS deps are injected so
// the core is testable and works per-role as each `outputArtifact` Zod schema
// lands (only `plan`/PlanArtifactSchema exists today).

import type { ZodType } from "zod";

import {
  writeBlob as defaultWriteBlob,
  setRef as defaultSetRef,
  type CasSha,
} from "../plan-store/cas.ts";
import { casUriFor as defaultCasUriFor } from "../plan-store/uri.ts";

export interface PinTransitionInput {
  /** Raw slot content — the transition artifact the run emitted (typically JSON). */
  raw: string;
  /**
   * Zod schema for the role's `outputArtifact` type (e.g. `PlanArtifactSchema`).
   * The object is validated against this regardless of any `--json-schema`
   * instruction given to the run — instrument is not finding.
   */
  schema: ZodType;
  /**
   * CAS domain — the producing actor's service domain. domain ⇒ provenance
   * (GH-2401): the `<domain>://` prefix is pinned to the source, not chosen ad hoc.
   */
  domain: string;
  /** Ref name to pin the artifact under (e.g. `transition:<actor>:<workUnitId>`). */
  ref: string;
}

export interface PinTransitionDeps {
  writeBlob?: typeof defaultWriteBlob;
  setRef?: typeof defaultSetRef;
  casUriFor?: typeof defaultCasUriFor;
}

export type PinTransitionResult =
  | { ok: true; handle: string; sha: CasSha }
  | {
      ok: false;
      reason: "empty" | "not_json" | "schema_invalid";
      detail: string;
    };

/**
 * Validate-then-pin. Returns a pinnable CAS handle on success, or a structured
 * rejection the exit gate turns into a `block` decision. Never pins an invalid
 * object (so a downstream step can trust a handle is a schema-valid typed input).
 */
export async function pinTransitionArtifact(
  input: PinTransitionInput,
  deps: PinTransitionDeps = {},
): Promise<PinTransitionResult> {
  const writeBlob = deps.writeBlob ?? defaultWriteBlob;
  const setRef = deps.setRef ?? defaultSetRef;
  const casUriFor = deps.casUriFor ?? defaultCasUriFor;

  if (typeof input.raw !== "string" || input.raw.trim().length === 0) {
    return {
      ok: false,
      reason: "empty",
      detail: "transition slot is empty — the run produced no artifact",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.raw);
  } catch (err) {
    return {
      ok: false,
      reason: "not_json",
      detail: `transition slot is not valid JSON: ${(err as Error).message}`,
    };
  }

  // VALIDATE THE OBJECT — the emitted bytes must satisfy the role's
  // outputArtifact schema, deterministically, before anything is persisted.
  const result = input.schema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      reason: "schema_invalid",
      detail: result.error.message,
    };
  }

  // validate-THEN-pin: persist the canonical validated object (not arbitrary
  // slot whitespace) so the handle is over the typed artifact. Only now does it
  // become a CAS handle the next transition can trust as a typed input.
  const canonical = JSON.stringify(result.data);
  const { sha } = await writeBlob(canonical, { domain: input.domain });
  await setRef(input.ref, sha, { domain: input.domain });
  return { ok: true, handle: casUriFor(input.domain, sha), sha };
}
