/**
 * prx-d2d (epic prx-997) — pipeline artifact-edge primitive contract.
 *
 * The cross-actor pass in the lifecycle is the CAS ref convention
 * `<unit>:<kind>@<slot>` (the proven plan→implement template), generalized into
 * a typed emit/consume pair. These tests ARE the contract: emit validates on the
 * way out, consume re-validates on the way in, a missing edge is observable
 * (not a crash), and the schema is the boundary that makes the edge trustworthy.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import {
  type ArtifactEdge,
  ArtifactValidationError,
  type ArtifactValidator,
  consumeArtifact,
  defineEdge,
  emitArtifact,
  isFresh,
  pinSource,
  runArtifactContract,
} from "../../src/pipeline/edge.ts";

const TestPayload = z.object({ greeting: z.string(), n: z.number().int() });
type TestPayload = z.infer<typeof TestPayload>;

// Reuse an existing ArtifactKind ("submit"); real edges register their own.
const edge: ArtifactEdge<TestPayload> = defineEdge({
  kind: "submit",
  slot: "edge-test",
  source: "alpha",
  target: "beta",
  schema: TestPayload,
});

let prevRoot: string | undefined;
beforeAll(() => {
  // Isolate the CAS to a throwaway dir (cas.ts honours PRX_CAS_ROOT first).
  prevRoot = process.env.PRX_CAS_ROOT;
  process.env.PRX_CAS_ROOT = mkdtempSync(join(tmpdir(), "prx-edge-cas-"));
});
afterAll(() => {
  if (prevRoot === undefined) delete process.env.PRX_CAS_ROOT;
  else process.env.PRX_CAS_ROOT = prevRoot;
});

describe("pipeline artifact edge (prx-d2d)", () => {
  test("emit→consume round-trips a typed artifact at <unit>:<kind>@<slot>", async () => {
    const emitted = await emitArtifact(edge, "GH-9999", { greeting: "hi", n: 7 });
    expect(emitted.ref).toBe("GH-9999:submit@edge-test");
    expect(emitted.sha).toMatch(/^sha256:[0-9a-f]{64}$/);

    const got = await consumeArtifact(edge, "GH-9999");
    expect(got.missing).toBeUndefined();
    expect(got.ref).toBe("GH-9999:submit@edge-test");
    expect(got.value).toEqual({ greeting: "hi", n: 7 });
  });

  test("consume reports missing (not a crash) for an edge never emitted", async () => {
    const got = await consumeArtifact(edge, "GH-0000-absent");
    expect(got.missing).toBe(true);
    expect(got.value).toBeNull();
  });

  test("emit rejects a payload that violates the edge schema (validate out)", async () => {
    let threw = false;
    try {
      // n must be a number; the edge schema is the contract.
      await emitArtifact(edge, "GH-8888", {
        greeting: "hi",
        n: "nope",
      } as unknown as TestPayload);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("consume re-validates against the schema (validate in)", async () => {
    // Emit a different shape under the SAME slot via a loose edge, then consume
    // with the strict edge → the boundary rejects the mismatch.
    const slot = "edge-test-shape";
    const loose = defineEdge({
      kind: "submit" as const,
      slot,
      source: "x",
      target: "y",
      schema: z.object({ other: z.string() }),
    });
    await emitArtifact(loose, "GH-7777", { other: "wrong-shape" });

    const strict = defineEdge({
      kind: "submit" as const,
      slot,
      source: "x",
      target: "y",
      schema: TestPayload,
    });
    let threw = false;
    try {
      await consumeArtifact(strict, "GH-7777");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("the edge declares its sole owners (source emits, target consumes)", () => {
    expect(edge.source).toBe("alpha");
    expect(edge.target).toBe("beta");
  });
});

describe("fixed-output pin — impure source → CAS (epic prx-997, path A)", () => {
  // An edge over a git-persisted artifact (e.g. a uow living as a GH issue/bead);
  // the fetcher stands in for the impure read. Injected ⇒ no real git/dolt.
  const gitEdge = defineEdge({
    kind: "submit" as const,
    slot: "fod-test",
    source: "intake",
    target: "triage",
    persistence: "git" as const,
    schema: TestPayload,
  });

  test("pinSource fetches the impure source and pins it; consume reads it back", async () => {
    const fetch = () => ({ greeting: "from-git", n: 1 });
    const { ref, sha } = await pinSource(gitEdge, "GH-5555", fetch);
    expect(ref).toBe("GH-5555:submit@fod-test");
    expect(sha).toMatch(/^sha256:[0-9a-f]{64}$/);

    const got = await consumeArtifact(gitEdge, "GH-5555");
    expect(got.value).toEqual({ greeting: "from-git", n: 1 });
  });

  test("isFresh: a pinned source is fresh; a drifted source is stale", async () => {
    let issue = { greeting: "v1", n: 1 };
    const fetch = () => issue;
    await pinSource(gitEdge, "GH-6666", fetch);

    const f1 = await isFresh(gitEdge, "GH-6666", fetch);
    expect(f1.fresh).toBe(true);
    expect(f1.pinnedSha).toBe(f1.sourceSha);

    issue = { greeting: "v2-edited", n: 2 }; // the GH issue was edited upstream
    const f2 = await isFresh(gitEdge, "GH-6666", fetch);
    expect(f2.fresh).toBe(false);
    expect(f2.pinnedSha).not.toBe(f2.sourceSha);
  });

  test("isFresh reports a never-pinned edge as not fresh (pinnedSha null)", async () => {
    const f = await isFresh(gitEdge, "GH-7000-unpinned", () => ({ greeting: "x", n: 0 }));
    expect(f.pinnedSha).toBeNull();
    expect(f.fresh).toBe(false);
  });

  test("the fetcher is injected — pinning touches no real git/dolt", async () => {
    let calls = 0;
    const fetch = () => {
      calls += 1;
      return { greeting: "counted", n: calls };
    };
    await pinSource(gitEdge, "GH-8001", fetch);
    expect(calls).toBe(1);
  });
});

describe("prx-bs4 — configurable validator pipeline per artifact", () => {
  // A semantic approver beyond the schema: n must be even.
  const evenOnly: ArtifactValidator<TestPayload> = (v) =>
    v.n % 2 === 0 ? [] : [{ code: "odd-n", path: "n", message: "n must be even" }];
  const guarded: ArtifactEdge<TestPayload> = defineEdge({
    kind: "submit",
    slot: "guarded",
    source: "a",
    target: "b",
    schema: TestPayload,
    validators: [evenOnly],
  });

  test("runArtifactContract reports schema THEN validator findings uniformly", () => {
    // schema failure → schema-invalid (no validators run on a bad shape).
    const bad = runArtifactContract(guarded, { greeting: "hi", n: 1.5 });
    expect(bad.diagnostics.map((d) => d.code)).toContain("schema-invalid");
    // schema ok but validator fails → the validator's own code.
    const odd = runArtifactContract(guarded, { greeting: "hi", n: 3 });
    expect(odd.diagnostics).toEqual([{ code: "odd-n", path: "n", message: "n must be even" }]);
    // fully valid → no diagnostics.
    expect(runArtifactContract(guarded, { greeting: "hi", n: 4 }).diagnostics).toEqual([]);
  });

  test("emit/consume enforce the validator pipeline (ArtifactValidationError)", async () => {
    await expect(emitArtifact(guarded, "GH-9100", { greeting: "hi", n: 3 })).rejects.toThrow(
      ArtifactValidationError,
    );
    // A valid value round-trips through emit + consume (both run the pipeline).
    await emitArtifact(guarded, "GH-9100", { greeting: "hi", n: 2 });
    const out = await consumeArtifact(guarded, "GH-9100");
    expect(out.value).toEqual({ greeting: "hi", n: 2 });
  });
});
