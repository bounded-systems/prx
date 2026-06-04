/**
 * Implement artifact (prx-pe1 slice 4b, epic prx-997).
 *
 * `prx implement agent` was the one pipeline step that produced no CAS artifact —
 * just a bare git commit, surfaced as stdout (see the artifact-kind table in the
 * session notes). This closes that asymmetry: a successful implement run pins a
 * typed `<unit>:implement@latest` artifact recording the commit it produced, the
 * files it touched, and a short summary.
 *
 * Self-certifying by reference, not by boolean: the artifact carries the
 * `commit` and nothing about whether checks passed. The verify step is the
 * separately-signed `checks/v1` attestation (prx-ux2), whose subject is *that
 * same commit*. So "did this implement pass its checks?" is answered by joining
 * the artifact's `commit` to a signed `checks/v1` in the ledger — an attestation
 * lookup, not a self-reported flag. The commit is the join key across the whole
 * chain (`commit/v1` → `checks/v1` → `push/v1`).
 */
import { z } from "zod";

import {
  type ArtifactDiagnostic,
  type ArtifactEdge,
  type ArtifactValidator,
  defineEdge,
  emitArtifact,
  runArtifactContract,
} from "./edge.ts";

const SHA1_RE = /^[0-9a-f]{40}$/;

export const implementArtifactSchema = z.object({
  /** The work unit this implements (the canonical id). */
  unit: z.string().min(1),
  /** The commit the executor produced — the artifact's identity + the subject
   *  that joins to the signed `commit/v1` / `checks/v1` / `push/v1` attestations. */
  commit: z.string().regex(SHA1_RE),
  /** Short human summary (the executor's final result text, truncated). */
  summary: z.string(),
  /** Files the commit touched (ground truth from `git show --name-only`, not
   *  self-reported by the agent). */
  files_changed: z.array(z.string()),
});
export type ImplementArtifact = z.infer<typeof implementArtifactSchema>;

/**
 * The semantic contract beyond the schema: the commit must be a real 40-hex oid
 * (the schema regex already enforces it; this keeps the failure legible as a
 * named diagnostic the same way the agent-result contract does).
 */
const implementContract: ArtifactValidator<ImplementArtifact> = (a) => {
  const diagnostics: ArtifactDiagnostic[] = [];
  if (!SHA1_RE.test(a.commit)) {
    diagnostics.push({
      code: "bad-commit",
      path: "commit",
      message: `commit must be a 40-hex git oid, got '${a.commit}'`,
    });
  }
  return diagnostics;
};

/** The implement edge: the executor pins what it produced for submit to consume. */
export const implementArtifactEdge: ArtifactEdge<ImplementArtifact> = defineEdge({
  kind: "implement",
  slot: "latest",
  source: "implement",
  target: "submit",
  schema: implementArtifactSchema,
  validators: [implementContract],
});

/**
 * Pin an implement outcome to `<unit>:implement@latest`. Runs the artifact
 * contract first; a violation is surfaced via diagnostics and NOT pinned. A
 * clean artifact is pinned best-effort — a CAS write failure must never break
 * the implement run (returns an empty ref then), mirroring `captureAgentResult`.
 */
export async function captureImplementArtifact(input: {
  unit: string;
  commit: string;
  summary: string;
  filesChanged: string[];
}): Promise<{
  ref: string;
  artifact: ImplementArtifact;
  diagnostics: readonly ArtifactDiagnostic[];
}> {
  const artifact: ImplementArtifact = {
    unit: input.unit,
    commit: input.commit,
    summary: input.summary,
    files_changed: input.filesChanged,
  };
  const { diagnostics } = runArtifactContract(implementArtifactEdge, artifact);
  if (diagnostics.length > 0) {
    return { ref: "", artifact, diagnostics };
  }
  try {
    const { ref } = await emitArtifact(implementArtifactEdge, input.unit, artifact);
    return { ref, artifact, diagnostics: [] };
  } catch {
    return { ref: "", artifact, diagnostics: [] };
  }
}

/** Injected seams so the finalize flow is testable without real git/checks. */
export interface FinalizeImplementDeps {
  /** Resolve the commit the run produced (`git rev-parse HEAD`); null if none. */
  resolveHead: (cwd: string) => string | null;
  /** List the files the commit touched (`git show --name-only`). */
  listChangedFiles: (cwd: string, commit: string) => string[];
  /**
   * Run the project checks against `commit`, emitting the signed `checks/v1`
   * attestation (prx-ux2). Returns whether checks passed (and were attested).
   * Optional: when absent (no signer/ledger configured) the implement artifact
   * is still pinned, and the absence of a `checks/v1` for the commit is itself
   * the "not verified" signal a downstream gate reads.
   */
  attestChecks?: (cwd: string, commit: string) => Promise<boolean>;
}

export interface FinalizeImplementResult {
  ref: string;
  artifact: ImplementArtifact | null;
  /** True when checks ran AND passed AND were attested (`checks/v1` emitted). */
  checksAttested: boolean;
  diagnostics: readonly ArtifactDiagnostic[];
}

/**
 * Tie a finished implement run into the artifact graph: resolve the commit it
 * produced, record the files it touched, optionally run+attest the checks, and
 * pin `<unit>:implement@latest`. A run that produced no commit pins nothing
 * (there is no artifact to certify) — honest, not a silent success.
 */
export async function finalizeImplementRun(
  input: { unit: string; summary: string; cwd: string },
  deps: FinalizeImplementDeps,
): Promise<FinalizeImplementResult> {
  const commit = deps.resolveHead(input.cwd);
  if (!commit) {
    return { ref: "", artifact: null, checksAttested: false, diagnostics: [] };
  }
  const filesChanged = deps.listChangedFiles(input.cwd, commit);
  const checksAttested = deps.attestChecks
    ? await deps.attestChecks(input.cwd, commit)
    : false;
  const captured = await captureImplementArtifact({
    unit: input.unit,
    commit,
    summary: input.summary,
    filesChanged,
  });
  return { ...captured, checksAttested };
}
