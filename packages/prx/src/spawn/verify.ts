/**
 * `prx spawn verify <unit> <role>` (GH-294) — the audit surface for the signed
 * SLSA spawn attestation (GH-293). Read-only: load `<unit>:spawn@<role>`, verify
 * its signature, check that its sole material still matches the currently-pinned
 * input, and print the SLSA provenance summary + verdict.
 *
 * The spawn attestation IS the ocap token; this verb is how an operator (or a
 * downstream gate) independently confirms it — "this leg was launched, signed,
 * over exactly this input."
 */
import { z } from "zod";

import { provenanceVerifier, type Verifier } from "../machine/machines/pilot-signing.ts";
import { getRef } from "../plan-store/cas.ts";
import { spawnEdge, verifySpawn } from "../pipeline/spawn-attestation.ts";

export const spawnVerifyOptionsSchema = z.object({
  unit: z.string().trim().min(1, "unit must not be empty"),
  role: z.string().trim().min(1, "role must not be empty"),
  format: z.enum(["plain", "json"]).default("plain"),
});
export type SpawnVerifyOptions = z.infer<typeof spawnVerifyOptionsSchema>;

type Output = { log: (line: string) => void; error: (line: string) => void };

export type SpawnVerifyDeps = {
  /** Override the verifier resolution (tests). */
  resolveVerifier?: () => Verifier | null;
  /** Override the current-pin lookup for the freshness check (tests). */
  getCurrentSha?: typeof getRef;
};

/**
 * Verify the persisted spawn attestation for `<unit>:spawn@<role>`. Returns 0 on
 * a valid, fresh attestation; 1 on any failure (no verifier, missing, bad
 * signature). Material drift (the pinned input changed since the spawn) is
 * surfaced but does not by itself fail the signature verdict — it's reported.
 */
export async function runSpawnVerify(
  options: SpawnVerifyOptions,
  output: Output,
  deps: SpawnVerifyDeps = {},
): Promise<number> {
  const verifier = (deps.resolveVerifier ?? provenanceVerifier)();
  if (!verifier) {
    output.error(
      "spawn verify: no verifier — set PRX_PROVENANCE_KEY=dev (or PRX_PROVENANCE_PUBKEY=ed25519:<b64>)",
    );
    return 1;
  }

  const result = await verifySpawn(options.unit, options.role, verifier);
  if (!result.ok) {
    if (options.format === "json") {
      output.log(
        JSON.stringify({
          unit: options.unit,
          role: options.role,
          ok: false,
          reason: result.reason,
        }),
      );
    } else {
      output.error(`spawn@${options.role} for ${options.unit}: NOT VERIFIED (${result.reason})`);
    }
    return 1;
  }

  const st = result.statement;
  const dep = st.predicate.buildDefinition.resolvedDependencies[0];
  // Freshness: does the recorded material still match the currently-pinned input?
  let freshness: "fresh" | "drifted" | "unknown" = "unknown";
  if (dep) {
    const current = await (deps.getCurrentSha ?? getRef)(dep.uri);
    freshness = current === null ? "unknown" : current === dep.digest.sha256 ? "fresh" : "drifted";
  }
  const builderId = st.predicate.runDetails.builder.id;

  if (options.format === "json") {
    output.log(
      JSON.stringify({
        unit: options.unit,
        role: options.role,
        ok: true,
        builder: builderId,
        signedBy: st.signedBy,
        material: dep ? { uri: dep.uri, sha256: dep.digest.sha256 } : null,
        freshness,
      }),
    );
  } else {
    output.log(`spawn@${options.role} for ${options.unit}: VERIFIED`);
    output.log(`  builder=${builderId}`);
    output.log(`  signedBy=${st.signedBy}`);
    if (dep) output.log(`  material=${dep.uri} sha256=${dep.digest.sha256} (${freshness})`);
  }
  return 0;
}

/** The `spawn@<role>` ref a `spawn verify` targets — exported for callers/tests. */
export function spawnRef(unit: string, role: string): string {
  const edge = spawnEdge(role);
  return `${unit}:${edge.kind}@${edge.slot}`;
}
