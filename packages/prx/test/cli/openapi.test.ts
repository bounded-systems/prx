// verbspec's fourth surface: the OpenAPI projection of the verb registry.
//
//   1. drift guard — committed packages/prx/openapi.json must match the generator
//      (run `bun run openapi:render` after changing any verb's input/output);
//   2. projection correctness — every registry verb becomes one POST operation;
//   3. a ratchet — no verb is "unprojectable" (every Zod schema renders).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { defineVerb, verbToken } from "@bounded-systems/verbspec";

import { buildOpenApiDocument, renderOpenApiDocument } from "../../src/cli/openapi.ts";
import { verbRegistry } from "../../src/cli/verb-registry.ts";

const TARGET = resolve(dirname(fileURLToPath(import.meta.url)), "../../openapi.json");

type Operation = {
  operationId?: string;
  requestBody?: unknown;
  responses?: Record<string, unknown>;
  "x-prx-unprojectable"?: string;
};
const opAt = (doc: ReturnType<typeof buildOpenApiDocument>, path: string): Operation | undefined =>
  (doc.paths as Record<string, { post?: Operation }>)[path]?.post;

describe("openapi projection (verbspec's 4th surface)", () => {
  test("committed openapi.json is up to date with `bun run openapi:render`", () => {
    const onDisk = readFileSync(TARGET, "utf8");
    expect(onDisk, "stale openapi.json — run `bun run openapi:render` and commit the result").toBe(
      renderOpenApiDocument(),
    );
  });

  test("is a valid OpenAPI 3.1 document", () => {
    const doc = buildOpenApiDocument();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBeTruthy();
    expect(doc.info.version).toBeTruthy();
    expect(Object.keys(doc.paths).length).toBe(Object.keys(verbRegistry).length);
  });

  test("every verb projects to a POST operation keyed by its id", () => {
    const doc = buildOpenApiDocument();
    for (const v of Object.values(verbRegistry)) {
      const op = opAt(doc, `/${v.id.split(" ").join("/")}`);
      expect(op, `missing operation for verb "${v.id}"`).toBeDefined();
      expect(op?.operationId).toBe(verbToken(v.id));
      expect(op?.requestBody).toBeDefined();
      expect(op?.responses?.["200"]).toBeDefined();
    }
  });

  test("no verb is unprojectable (every Zod schema renders to JSON Schema)", () => {
    const doc = buildOpenApiDocument();
    const unprojectable = Object.entries(doc.paths as Record<string, { post?: Operation }>)
      .filter(([, p]) => p.post?.["x-prx-unprojectable"])
      .map(([path, p]) => `${path}: ${p.post?.["x-prx-unprojectable"]}`);
    expect(unprojectable, "verbs whose Zod schema can't project to OpenAPI").toEqual([]);
  });

  test("a verb whose Zod schema can't project is surfaced, not fatal", () => {
    // z.date() is unrepresentable in JSON Schema (z.toJSONSchema throws), so the
    // operation must still emit with x-prx-unprojectable rather than crash the doc.
    const badVerb = defineVerb({
      id: "x unprojectable",
      summary: "deliberately unprojectable (z.date input)",
      actor: "work",
      input: z.object({ when: z.date() }),
      output: z.object({ ok: z.boolean() }),
      run: () => ({ ok: true }),
    });
    const doc = buildOpenApiDocument({ [badVerb.id]: badVerb });
    const op = opAt(doc, "/x/unprojectable");
    expect(op?.operationId).toBe("x_unprojectable");
    expect(op?.["x-prx-unprojectable"]).toContain("Date");
    expect(op?.requestBody).toBeDefined();
    expect(op?.responses?.["200"]).toBeDefined();
  });
});
