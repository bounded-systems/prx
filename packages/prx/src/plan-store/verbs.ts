// GH-1173: operator-facing verb surface over the GH-1174 CAS plan store.
// Pure module — no process.* access. CLI handlers in src/pr-state/cli.ts
// inject content as string|Buffer and resolve unit IDs before calling here.

import { getRef, readBlob, type CasSha, writeBlob } from "./cas.ts";
import { artifactRef, putArtifact } from "./artifact-store.ts";
import {
  type PlanDiagnostic,
  type PlanEnvelope,
  PLAN_ENVELOPE_SCHEMA_VERSION,
  parseEnvelope,
  serializeEnvelope,
} from "./envelope.ts";
import { validatePlanBody } from "./plan-artifact.ts";
// GH-1239: re-export the preflight verb under the plan-store namespace so the
// CLI's CliDeps seam picks it up alongside save/load/show. Implementation
// lives under src/plan/ to keep the IO-heavy preflight logic out of the pure
// CAS layer.
export { runPlanPreflight, formatPreflightPlain } from "../plan/preflight.ts";
export type {
  RunPlanPreflightInput,
  RunPlanPreflightDeps,
} from "../plan/preflight.ts";
export type { PreflightResult } from "../plan/preflight_schema.ts";

export type PlanSlot = "draft" | "approved";

export const PLAN_SLOTS: readonly PlanSlot[] = ["draft", "approved"] as const;

export function refName(unit: string, slot: PlanSlot): string {
  return artifactRef(unit, "plan", slot);
}

export interface RunPlanSaveInput {
  unit: string;
  slot: PlanSlot;
  content: string | Buffer;
  // GH-2028: loud escape hatch. Under persist-on-failure the body is *always*
  // written; when true, the envelope's `validated_ok` is forced to true so the
  // slot is consumable despite shape diagnostics (CLI emits a stderr warning).
  skipValidate?: boolean;
}

export interface RunPlanSaveResult {
  // The ref target — the envelope blob's digest.
  sha: CasSha;
  ref: string;
  // GH-2028 persist-on-failure envelope fields.
  body_sha: CasSha;
  envelope_sha: CasSha;
  validated_ok: boolean;
  diagnostics: PlanDiagnostic[];
}

// GH-2028: persist-on-failure. The body is always written to CAS; the
// content-validation verdict rides in a content-addressed envelope and refusal
// moves to the consumer (`prx implement agent`). Input-channel guards
// (empty-stdin, GH-1237) live at the CLI/producer boundary and are unaffected —
// they protect the channel, not the content.
export async function runPlanSave(input: RunPlanSaveInput): Promise<RunPlanSaveResult> {
  // prx-bs4: validate through the unified, format-dispatching contract — a JSON
  // PlanArtifact body is checked against PlanArtifactSchema, a (legacy) markdown
  // body against the `## Scope` gate. The `## Scope` check is now ONE branch of
  // the single plan contract rather than a parallel hardcoded path.
  const contentText =
    typeof input.content === "string" ? input.content : input.content.toString("utf8");
  const verdict = validatePlanBody(contentText, input.unit);
  // skipValidate forces the slot consumable despite diagnostics. The body and
  // its diagnostics are still persisted so the verdict stays auditable.
  const validated_ok = input.skipValidate ? true : verdict.validated_ok;
  const diagnostics = verdict.diagnostics;

  const { sha: body_sha } = await writeBlob(input.content);
  const envelope: PlanEnvelope = {
    schema_version: PLAN_ENVELOPE_SCHEMA_VERSION,
    body_sha,
    validated_ok,
    diagnostics,
  };
  const ref = refName(input.unit, input.slot);
  const { sha: envelope_sha } = await putArtifact(ref, serializeEnvelope(envelope));
  return { sha: envelope_sha, ref, body_sha, envelope_sha, validated_ok, diagnostics };
}

// GH-2028: resolve a ref target (envelope or legacy raw body) into the body
// bytes plus the content-validation verdict. Lazy migration: a legacy bare-sha
// ref points straight at a raw body blob — those were only ever written when
// validation passed, so we synthesize `validated_ok: true`. The ref upgrades to
// envelope format on the next `runPlanSave`; no on-disk rewrite here.
interface ResolvedBody {
  body: Buffer;
  body_sha: CasSha;
  validated_ok: boolean;
  diagnostics: PlanDiagnostic[];
}

async function resolveBody(refSha: CasSha): Promise<ResolvedBody> {
  const blob = await readBlob(refSha);
  const envelope = parseEnvelope(blob);
  if (envelope === null) {
    // Legacy raw body blob (pre-envelope ref).
    return { body: blob, body_sha: refSha, validated_ok: true, diagnostics: [] };
  }
  const body = await readBlob(envelope.body_sha);
  return {
    body,
    body_sha: envelope.body_sha,
    validated_ok: envelope.validated_ok,
    diagnostics: envelope.diagnostics,
  };
}

export interface RunPlanLoadInput {
  unit: string;
  slot: PlanSlot;
  // When true, an approved-slot miss falls back to draft. Used by the CLI
  // when --slot was not specified (default load = approved-with-fallback).
  fallbackToDraft?: boolean;
}

export interface RunPlanLoadResult {
  // The ref target (envelope blob for new refs, raw body blob for legacy).
  sha: CasSha;
  content: Buffer;
  slot: PlanSlot;
  fellBackToDraft: boolean;
  // GH-2028 persist-on-failure verdict surfaced from the envelope.
  validated_ok: boolean;
  diagnostics: PlanDiagnostic[];
}

export class PlanRefNotFound extends Error {
  readonly code = "PLAN_REF_NOT_FOUND";
  readonly unit: string;
  readonly slot: PlanSlot;
  constructor(unit: string, slot: PlanSlot) {
    super(`no plan blob for ${unit} (slot=${slot})`);
    this.name = "PlanRefNotFound";
    this.unit = unit;
    this.slot = slot;
  }
}

export async function runPlanLoad(input: RunPlanLoadInput): Promise<RunPlanLoadResult> {
  const primary = await getRef(refName(input.unit, input.slot));
  if (primary !== null) {
    const resolved = await resolveBody(primary);
    return {
      sha: primary,
      content: resolved.body,
      slot: input.slot,
      fellBackToDraft: false,
      validated_ok: resolved.validated_ok,
      diagnostics: resolved.diagnostics,
    };
  }
  if (input.fallbackToDraft && input.slot === "approved") {
    const draft = await getRef(refName(input.unit, "draft"));
    if (draft !== null) {
      const resolved = await resolveBody(draft);
      return {
        sha: draft,
        content: resolved.body,
        slot: "draft",
        fellBackToDraft: true,
        validated_ok: resolved.validated_ok,
        diagnostics: resolved.diagnostics,
      };
    }
  }
  throw new PlanRefNotFound(input.unit, input.slot);
}

export interface RunPlanShowInput {
  unit: string;
  // When provided, only that slot is consulted (no fallback). When undefined,
  // approved is tried first and falls back to draft.
  slot?: PlanSlot | undefined;
}

export interface RunPlanShowResult {
  unit: string;
  slot: PlanSlot;
  sha: CasSha;
  size: number;
  body: Buffer;
  // GH-2028 persist-on-failure verdict surfaced from the envelope.
  validated_ok: boolean;
  diagnostics: PlanDiagnostic[];
}

// `show` resolves approved first, then draft when slot is unspecified.
// An explicit slot disables fallback so operators can introspect a specific
// ref. Same not-found semantics as load.
export async function runPlanShow(input: RunPlanShowInput): Promise<RunPlanShowResult> {
  const slots = input.slot ? [input.slot] : (["approved", "draft"] as const);
  for (const slot of slots) {
    const sha = await getRef(refName(input.unit, slot));
    if (sha !== null) {
      const resolved = await resolveBody(sha);
      return {
        unit: input.unit,
        slot,
        sha,
        size: resolved.body.length,
        body: resolved.body,
        validated_ok: resolved.validated_ok,
        diagnostics: resolved.diagnostics,
      };
    }
  }
  throw new PlanRefNotFound(input.unit, input.slot ?? "approved");
}
