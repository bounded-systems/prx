/**
 * GH-294: `prx spawn verify` — the audit surface for the signed SLSA spawn
 * attestation. Verifies a minted spawn, reports material freshness, and fails
 * closed on a missing attestation or absent verifier.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { provenanceSigner, provenanceVerifier, realStatementSigner } from "../../src/machine/machines/pilot-signing.ts";
import { mintSpawnAttestation } from "../../src/pipeline/spawn-attestation.ts";
import { runSpawnVerify } from "../../src/spawn/verify.ts";

let prevRoot: string | undefined;
let prevKey: string | undefined;
let prevPerActor: string | undefined;
beforeAll(() => {
  prevRoot = process.env.PRX_CAS_ROOT;
  prevKey = process.env.PRX_PROVENANCE_KEY;
  prevPerActor = process.env.PRX_PROVENANCE_PER_ACTOR;
  process.env.PRX_CAS_ROOT = mkdtempSync(join(tmpdir(), "gh-294-spawn-verify-"));
  process.env.PRX_PROVENANCE_KEY = "dev";
  process.env.PRX_PROVENANCE_PER_ACTOR = "off";
});
afterAll(() => {
  if (prevRoot === undefined) delete process.env.PRX_CAS_ROOT;
  else process.env.PRX_CAS_ROOT = prevRoot;
  if (prevKey === undefined) delete process.env.PRX_PROVENANCE_KEY;
  else process.env.PRX_PROVENANCE_KEY = prevKey;
  if (prevPerActor === undefined) delete process.env.PRX_PROVENANCE_PER_ACTOR;
  else process.env.PRX_PROVENANCE_PER_ACTOR = prevPerActor;
});

const sink = () => {
  const lines: string[] = [];
  const errs: string[] = [];
  return { out: { log: (l: string) => lines.push(l), error: (l: string) => errs.push(l) }, lines, errs };
};

const mint = (unit: string) =>
  mintSpawnAttestation(
    { unit, role: "plan", actor: "pilot", input: { ref: `${unit}:source@pinned`, sha: "sha256:material1" } },
    realStatementSigner(provenanceSigner()!),
  );

describe("prx spawn verify (GH-294)", () => {
  test("verifies a minted spawn and reports the material (json)", async () => {
    await mint("GH-1");
    const { out, lines } = sink();
    const code = await runSpawnVerify(
      { unit: "GH-1", role: "plan", format: "json" },
      out,
      { resolveVerifier: () => provenanceVerifier(), getCurrentSha: async () => "sha256:material1" },
    );
    expect(code).toBe(0);
    const payload = JSON.parse(lines[0]!);
    expect(payload.ok).toBe(true);
    expect(payload.builder).toBe("prx-claude://plan");
    expect(payload.material).toEqual({ uri: "GH-1:source@pinned", sha256: "sha256:material1" });
    expect(payload.freshness).toBe("fresh");
  });

  test("reports drift when the pinned input changed since the spawn", async () => {
    await mint("GH-drift");
    const { out, lines } = sink();
    const code = await runSpawnVerify(
      { unit: "GH-drift", role: "plan", format: "json" },
      out,
      { resolveVerifier: () => provenanceVerifier(), getCurrentSha: async () => "sha256:CHANGED" },
    );
    expect(code).toBe(0);
    expect(JSON.parse(lines[0]!).freshness).toBe("drifted");
  });

  test("fails closed when no spawn attestation exists", async () => {
    const { out } = sink();
    const code = await runSpawnVerify(
      { unit: "GH-none", role: "plan", format: "json" },
      out,
      { resolveVerifier: () => provenanceVerifier() },
    );
    expect(code).toBe(1);
  });

  test("fails closed when no verifier is configured", async () => {
    const { out, errs } = sink();
    const code = await runSpawnVerify(
      { unit: "GH-1", role: "plan", format: "plain" },
      out,
      { resolveVerifier: () => null },
    );
    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/no verifier/i);
  });
});
