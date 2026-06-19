/**
 * The `scope-gate` actor (prx-tth, epic prx-9zh) — the reference Gate.
 *
 * It answers one question with a signed verdict: *did the implementation stay
 * inside the scope the plan declared?* Its input is the SIGNED plan artifact's
 * structured `paths` allowlist; it checks `implement.files_changed ⊆ plan.paths`
 * and emits a `gate/v1` attestation + a `gate@scope` verdict via {@link runGate}.
 *
 * This replaces the orchestrator hand-checking "diff scope = these 4 files" in
 * the shell — now it is an actor that leaves durable, attestable evidence.
 *
 * Fail-closed: an empty `plan.paths` (no declared scope, or a legacy markdown
 * plan) yields a signed *fail* verdict, not a pass — so an undeclared scope is
 * an explicit, recorded gate failure that pushes planners to declare `paths`.
 *
 * `files_changed` is taken from the implement artifact (already git ground-truth
 * from `git show --name-only`, not self-reported), so the gate needs no git of
 * its own. All other side effects (plan read, signer, ledger) are injectable.
 */
import { type ImplementArtifact, implementArtifactEdge } from "../pipeline/implement-artifact.ts";
import { consumeArtifact } from "../pipeline/edge.ts";
import { detectPlanBodyFormat, PlanArtifactSchema } from "../plan-store/plan-artifact.ts";
import { runPlanLoad } from "../plan-store/verbs.ts";
import type { AttestDeps } from "../provenance/attest.ts";
import { type GateResult, runGate } from "../provenance/gate.ts";

/** The gate name + verdict slot: `<unit>:gate@scope`. */
export const SCOPE_GATE_NAME = "scope";

/** Raised when scope-gate is run before there is anything to gate. */
export class ScopeGateInputError extends Error {
  readonly code = "SCOPE_GATE_NO_IMPLEMENT";
  constructor(readonly unit: string) {
    super(`scope-gate: no implement artifact for ${unit} (run implement before gating its scope)`);
    this.name = "ScopeGateInputError";
  }
}

/** Injectable seams: real defaults read the plan store + CAS; tests stub them. */
export interface ScopeGateDeps extends AttestDeps {
  /** Resolve the declared path allowlist from the plan artifact. */
  readonly loadPlanPaths?: (unit: string) => Promise<readonly string[]>;
  /** Resolve the implement artifact (commit + files_changed). */
  readonly loadImplement?: (unit: string) => Promise<ImplementArtifact | null>;
}

/**
 * Read the structured `paths` allowlist off a unit's plan. Returns `[]` (which
 * the gate treats as fail-closed) for a missing plan, a legacy markdown body, or
 * a body that does not parse as a {@link PlanArtifactSchema} — i.e. any case
 * where no machine-checkable scope was declared.
 */
async function defaultLoadPlanPaths(unit: string): Promise<readonly string[]> {
  let body: string;
  try {
    const loaded = await runPlanLoad({ unit, slot: "approved", fallbackToDraft: true });
    body = loaded.content.toString("utf8");
  } catch {
    return [];
  }
  if (detectPlanBodyFormat(body) !== "json") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const result = PlanArtifactSchema.safeParse(parsed);
  return result.success ? result.data.paths : [];
}

async function defaultLoadImplement(unit: string): Promise<ImplementArtifact | null> {
  const consumed = await consumeArtifact(implementArtifactEdge, unit);
  return consumed.missing ? null : consumed.value;
}

/**
 * Run the scope gate for `unit`: compare the implement artifact's changed files
 * against the plan's declared `paths` and emit a signed `gate@scope` verdict.
 * Throws {@link ScopeGateInputError} when there is no implement artifact to gate.
 */
export async function runScopeGate(unit: string, deps: ScopeGateDeps): Promise<GateResult> {
  const loadPaths = deps.loadPlanPaths ?? defaultLoadPlanPaths;
  const loadImpl = deps.loadImplement ?? defaultLoadImplement;

  const impl = await loadImpl(unit);
  if (impl === null) throw new ScopeGateInputError(unit);

  const allow = new Set(await loadPaths(unit));
  const violations = impl.files_changed.filter((f) => !allow.has(f));
  const pass = allow.size > 0 && violations.length === 0;

  const reason =
    allow.size === 0
      ? "plan declared no path allowlist (fail-closed)"
      : violations.length > 0
        ? `${violations.length} file(s) outside declared scope`
        : `all ${impl.files_changed.length} changed file(s) within declared scope`;

  return runGate(
    {
      unit,
      gate: SCOPE_GATE_NAME,
      subjectCommit: impl.commit,
      pass,
      violations,
      reason,
    },
    deps,
  );
}
