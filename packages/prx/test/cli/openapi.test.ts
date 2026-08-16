// verbspec's fourth surface: the OpenAPI projection of the verb registry.
//
//   1. drift guard — committed packages/prx/openapi.json must match the generator
//      (run `bun run openapi:render` after changing any verb's input/output);
//   2. projection correctness — every verb is one POST op whose request/response
//      $ref a hoisted `components/schemas` entry;
//   3. self-contained — every $ref resolves and every component is referenced;
//   4. a ratchet — no verb is "unprojectable" (every Zod schema renders).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { defineVerb, verbToken } from "@bounded-systems/verbspec";

import { buildOpenApiDocument, renderOpenApiDocument } from "../../src/cli/openapi.ts";
import { verbRegistry } from "../../src/cli/verb-registry.ts";

const TARGET = resolve(dirname(fileURLToPath(import.meta.url)), "../../openapi.json");

type RefOrSchema = { $ref?: string };
type Operation = {
  operationId?: string;
  requestBody?: { content?: Record<string, { schema?: RefOrSchema }> };
  responses?: Record<string, { content?: Record<string, { schema?: RefOrSchema }> }>;
  "x-prx-unprojectable"?: string;
};
type Doc = ReturnType<typeof buildOpenApiDocument>;

const opAt = (doc: Doc, path: string): Operation | undefined =>
  (doc.paths as Record<string, { post?: Operation }>)[path]?.post;
const components = (doc: Doc): Record<string, unknown> =>
  doc.components.schemas as Record<string, unknown>;
const reqRef = (op: Operation | undefined): string | undefined =>
  op?.requestBody?.content?.["application/json"]?.schema?.$ref;
const resRef = (op: Operation | undefined): string | undefined =>
  op?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref;

describe("openapi projection (verbspec's 4th surface)", () => {
  test("committed openapi.json is up to date with `bun run openapi:render`", () => {
    const onDisk = readFileSync(TARGET, "utf8");
    expect(onDisk, "stale openapi.json — run `bun run openapi:render` and commit the result").toBe(
      renderOpenApiDocument(),
    );
  });

  test("is a valid OpenAPI 3.1 document with hoisted components", () => {
    const doc = buildOpenApiDocument();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBeTruthy();
    expect(doc.info.version).toBeTruthy();
    expect(Object.keys(doc.paths).length).toBe(Object.keys(verbRegistry).length);
    // input + output per verb, hoisted into components/schemas.
    expect(Object.keys(components(doc)).length).toBe(Object.keys(verbRegistry).length * 2);
  });

  test("every verb is a POST op whose request/response $ref a hoisted component", () => {
    const doc = buildOpenApiDocument();
    const schemas = components(doc);
    for (const v of Object.values(verbRegistry)) {
      const token = verbToken(v.id);
      const op = opAt(doc, `/${v.id.split(" ").join("/")}`);
      expect(op, `missing operation for verb "${v.id}"`).toBeDefined();
      expect(op?.operationId).toBe(token);
      expect(reqRef(op)).toBe(`#/components/schemas/${token}Input`);
      expect(resRef(op)).toBe(`#/components/schemas/${token}Output`);
      expect(schemas[`${token}Input`], `missing Input component for "${v.id}"`).toBeDefined();
      expect(schemas[`${token}Output`], `missing Output component for "${v.id}"`).toBeDefined();
    }
  });

  test("the document is self-contained — no dangling $refs, no orphan components", () => {
    const doc = buildOpenApiDocument();
    const defined = new Set(Object.keys(components(doc)));
    const referenced = new Set(
      [...JSON.stringify(doc).matchAll(/#\/components\/schemas\/([A-Za-z0-9_.-]+)/g)].map(
        (m) => m[1] as string,
      ),
    );
    const dangling = [...referenced].filter((r) => !defined.has(r));
    const orphans = [...defined].filter((d) => !referenced.has(d));
    expect(dangling, "refs with no matching component").toEqual([]);
    expect(orphans, "components nothing references").toEqual([]);
  });

  test("no verb is unprojectable (every Zod schema renders to JSON Schema)", () => {
    const doc = buildOpenApiDocument();
    const unprojectable = Object.entries(doc.paths as Record<string, { post?: Operation }>)
      .filter(([, p]) => p.post?.["x-prx-unprojectable"])
      .map(([path, p]) => `${path}: ${p.post?.["x-prx-unprojectable"]}`);
    expect(unprojectable, "verbs whose Zod schema can't project to OpenAPI").toEqual([]);
  });

  test("a verb whose Zod schema can't project is surfaced inline, not fatal", () => {
    // z.date() is unrepresentable in JSON Schema (z.toJSONSchema throws), so the
    // operation is emitted inline with x-prx-unprojectable and contributes no
    // component — rather than crashing the whole doc.
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
    expect(reqRef(op)).toBeUndefined(); // inline shell, not a component $ref
    expect(Object.keys(components(doc))).toEqual([]);
  });
});
