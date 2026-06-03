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
  consumeArtifact,
  defineEdge,
  emitArtifact,
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
