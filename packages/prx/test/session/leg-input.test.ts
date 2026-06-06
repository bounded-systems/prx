/**
 * GH-288: the leg-input consume seam — a session actor's required upstream
 * artifact, read + embedded before the leg spawns. "No artifact → no spawn":
 * a missing (or unsigned) input is the caller's hard-fail signal.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResolvedWorkUnit } from "../../src/pr-state/resolvers/types.ts";
import { emitArtifact } from "../../src/pipeline/edge.ts";
import { pinWorkUnitSource, workUnitSourceEdge } from "../../src/pipeline/source-pin.ts";
import { provenanceSigner, realStatementSigner } from "../../src/machine/machines/pilot-signing.ts";
import type { StatementSigner } from "../../src/machine/machines/provenance.ts";
import { legInputEdge, resolveLegInput } from "../../src/session/leg-input.ts";

const issue = (overrides: Partial<ResolvedWorkUnit> = {}): ResolvedWorkUnit => ({
  id: "GH-1",
  title: "task: wire the planner input",
  body: "the planner must receive the issue as input",
  state: "open",
  url: "https://github.com/o/r/issues/1",
  source: "github",
  ...overrides,
});

let prevRoot: string | undefined;
let prevKey: string | undefined;
let prevPerActor: string | undefined;
let signer: StatementSigner;
beforeAll(() => {
  prevRoot = process.env.PRX_CAS_ROOT;
  prevKey = process.env.PRX_PROVENANCE_KEY;
  prevPerActor = process.env.PRX_PROVENANCE_PER_ACTOR;
  process.env.PRX_CAS_ROOT = mkdtempSync(join(tmpdir(), "gh-288-leg-input-"));
  process.env.PRX_PROVENANCE_KEY = "dev";
  process.env.PRX_PROVENANCE_PER_ACTOR = "off";
  signer = realStatementSigner(provenanceSigner()!);
});
afterAll(() => {
  if (prevRoot === undefined) delete process.env.PRX_CAS_ROOT;
  else process.env.PRX_CAS_ROOT = prevRoot;
  if (prevKey === undefined) delete process.env.PRX_PROVENANCE_KEY;
  else process.env.PRX_PROVENANCE_KEY = prevKey;
  if (prevPerActor === undefined) delete process.env.PRX_PROVENANCE_PER_ACTOR;
  else process.env.PRX_PROVENANCE_PER_ACTOR = prevPerActor;
});

describe("resolveLegInput (GH-288)", () => {
  test("plan: resolves the embedded body from a signed pinned source", async () => {
    await pinWorkUnitSource("GH-1", issue(), signer);
    const got = await resolveLegInput("plan", "GH-1");
    expect(got).not.toBeNull();
    expect(got!.missing).toBe(false);
    if (!got!.missing) {
      expect(got!.ref).toBe("GH-1:source@pinned");
      expect(got!.body).toContain("task: wire the planner input");
      expect(got!.body).toContain("the planner must receive the issue as input");
      expect(got!.signedBy.length).toBeGreaterThan(0);
    }
  });

  test("plan: missing when nothing is pinned (→ caller fails closed)", async () => {
    const got = await resolveLegInput("plan", "GH-unpinned");
    expect(got).not.toBeNull();
    expect(got!.missing).toBe(true);
  });

  test("plan: missing when the pin is UNSIGNED (no attestation)", async () => {
    // Emit a pre-signing-shaped pin directly (attestation omitted).
    await emitArtifact(workUnitSourceEdge, "GH-unsigned", {
      id: "GH-unsigned",
      title: "legacy unsigned pin",
      body: "should not be trusted as a leg input",
      state: "open",
      url: null,
      source: "github",
    });
    const got = await resolveLegInput("plan", "GH-unsigned");
    expect(got!.missing).toBe(true);
  });

  test("intake is a chain root: no input edge (exempt → null)", async () => {
    expect(legInputEdge("intake")).toBeNull();
    expect(await resolveLegInput("intake", "GH-1")).toBeNull();
  });
});
