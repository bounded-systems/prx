/**
 * prx-adj / GH-292: the work-unit source pin — the issue/bead authority becomes a
 * SIGNED, content-anchored chain ROOT (`<unit>:source@pinned`).
 *
 * These tests are the contract: a pin round-trips the resolved source AND carries
 * the submitter's signature over the input text; `verifyWorkUnitSource` accepts a
 * valid pin and rejects a tampered one; freshness is true for an unchanged source
 * and false once it drifts; the best-effort wrapper never throws.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResolvedWorkUnit } from "../../src/pr-state/resolvers/types.ts";
import { consumeArtifact } from "../../src/pipeline/edge.ts";
import {
  provenanceSigner,
  provenanceVerifier,
  realStatementSigner,
} from "../../src/machine/machines/pilot-signing.ts";
import type { StatementSigner } from "../../src/machine/machines/provenance.ts";
import type { Verifier } from "../../src/machine/machines/pilot-signing.ts";
import {
  pinWorkUnitSource,
  pinWorkUnitSourceBestEffort,
  verifyWorkUnitSource,
  workUnitSourceEdge,
  workUnitSourceFresh,
} from "../../src/pipeline/source-pin.ts";

const issue = (overrides: Partial<ResolvedWorkUnit> = {}): ResolvedWorkUnit => ({
  id: "prx-0v5",
  title: "task: README is out of date",
  body: "the README drifted from the code",
  state: "open",
  url: "bd://prx-0v5",
  source: "beads",
  ...overrides,
});

let prevRoot: string | undefined;
let prevKey: string | undefined;
let prevPerActor: string | undefined;
let signer: StatementSigner;
let verifier: Verifier;
beforeAll(() => {
  prevRoot = process.env.PRX_CAS_ROOT;
  prevKey = process.env.PRX_PROVENANCE_KEY;
  prevPerActor = process.env.PRX_PROVENANCE_PER_ACTOR;
  process.env.PRX_CAS_ROOT = mkdtempSync(join(tmpdir(), "prx-source-pin-"));
  process.env.PRX_PROVENANCE_KEY = "dev";
  // Single-key dev mode so signer + verifier share one keypair (per-actor verifier
  // resolution is exercised at the consume/spawn seam, GH-288/GH-293).
  process.env.PRX_PROVENANCE_PER_ACTOR = "off";
  signer = realStatementSigner(provenanceSigner()!);
  verifier = provenanceVerifier()!;
});
afterAll(() => {
  if (prevRoot === undefined) delete process.env.PRX_CAS_ROOT;
  else process.env.PRX_CAS_ROOT = prevRoot;
  if (prevKey === undefined) delete process.env.PRX_PROVENANCE_KEY;
  else process.env.PRX_PROVENANCE_KEY = prevKey;
  if (prevPerActor === undefined) delete process.env.PRX_PROVENANCE_PER_ACTOR;
  else process.env.PRX_PROVENANCE_PER_ACTOR = prevPerActor;
});

describe("work-unit source pin (prx-adj / GH-292 signed root)", () => {
  test("pins the signed source at <unit>:source@pinned, round-trips content + attestation", async () => {
    const { ref } = await pinWorkUnitSource("prx-0v5", issue(), signer);
    expect(ref).toBe("prx-0v5:source@pinned");

    const got = await consumeArtifact(workUnitSourceEdge, "prx-0v5");
    expect(got.value).toMatchObject({
      id: "prx-0v5",
      title: "task: README is out of date",
      body: "the README drifted from the code",
      state: "open",
      url: "bd://prx-0v5",
      source: "beads",
    });
    // GH-292: the signature over the input text IS the artifact.
    expect(got.value?.attestation).toBeDefined();
    expect(got.value?.attestation?.predicateType).toBe("https://prx.bounded.systems/intake/v1");
    expect(got.value?.attestation?.submittedBy.length).toBeGreaterThan(0);
    expect(got.value?.attestation?.sig.length).toBeGreaterThan(0);
  });

  test("verifyWorkUnitSource accepts a valid pin and rejects a tampered body", async () => {
    await pinWorkUnitSource("prx-verify", issue({ id: "prx-verify" }), signer);
    const got = await consumeArtifact(workUnitSourceEdge, "prx-verify");
    expect(got.value).not.toBeNull();

    expect(await verifyWorkUnitSource(got.value!, verifier)).toBe(true);

    // Tamper the input text — the signature no longer commits to it.
    const tampered = { ...got.value!, body: "malicious edit" };
    expect(await verifyWorkUnitSource(tampered, verifier)).toBe(false);

    // An unsigned value is unverifiable.
    const unsigned = { ...got.value!, attestation: undefined };
    expect(await verifyWorkUnitSource(unsigned, verifier)).toBe(false);
  });

  test("freshness: a pinned source is fresh; a drifted source is stale", async () => {
    await pinWorkUnitSource("prx-fresh", issue({ id: "prx-fresh" }), signer);

    const same = await workUnitSourceFresh("prx-fresh", issue({ id: "prx-fresh" }));
    expect(same.fresh).toBe(true);
    expect(same.pinnedSha).toBe(same.sourceSha);

    // The upstream issue was edited (title changed) since the pin.
    const drifted = await workUnitSourceFresh(
      "prx-fresh",
      issue({ id: "prx-fresh", title: "task: README — now actually fixed" }),
    );
    expect(drifted.fresh).toBe(false);
    expect(drifted.pinnedSha).not.toBe(drifted.sourceSha);
  });

  test("an unpinned unit reports not fresh (pinnedSha null)", async () => {
    const f = await workUnitSourceFresh("prx-never", issue({ id: "prx-never" }));
    expect(f.pinnedSha).toBeNull();
    expect(f.fresh).toBe(false);
  });

  test("best-effort pin reports success (ambient key) and never throws", async () => {
    const r = await pinWorkUnitSourceBestEffort("prx-be", issue({ id: "prx-be" }));
    expect(r.pinned).toBe(true);
    expect(r.ref).toBe("prx-be:source@pinned");
  });

  test("best-effort pin degrades to pinned:false with NO signer (never writes unsigned)", async () => {
    const saved = process.env.PRX_PROVENANCE_KEY;
    delete process.env.PRX_PROVENANCE_KEY;
    try {
      const r = await pinWorkUnitSourceBestEffort("prx-nokey", issue({ id: "prx-nokey" }));
      expect(r.pinned).toBe(false);
      const got = await consumeArtifact(workUnitSourceEdge, "prx-nokey");
      expect(got.missing).toBe(true);
    } finally {
      process.env.PRX_PROVENANCE_KEY = saved;
    }
  });
});
