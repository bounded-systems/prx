/**
 * OpenAPI projection of the prx VerbSpec registry — verbspec's fourth surface
 * (CLI / MCP / Anthropic / OpenAPI). The verb registry is the single source.
 *
 * Each verb's Zod input/output is hoisted into `components/schemas` as
 * `<VerbToken>Input` / `<VerbToken>Output`, and every operation is a thin `$ref`
 * into that block — the conventional OpenAPI shape (readable paths, centralized
 * and consumer-referenceable schemas), and the structure any shared sub-schema
 * would be deduped into.
 *
 * Note on dedup: today the verbs' schemas are fully self-contained (zero shared
 * sub-schemas — a standalone `z.toJSONSchema` of every verb emits no `$ref`/
 * `$defs`), so the components are 1:1 with the operations; the hoist buys the
 * structure, not a size win. Zod's registry-based dedup was a dead end here — it
 * emits dangling `$ref`s for the space-namespaced verb ids (`plan close` →
 * `plan`) and shared input instances — so the components and refs are built by
 * hand to keep ids and refs consistent and the document self-contained.
 *
 * Generated to `packages/prx/openapi.json` by `scripts/gen-openapi.ts` and
 * drift-gated by `test/cli/openapi.test.ts` — edit the verbs, never the JSON.
 *
 * Deliberately NOT a verb in the registry: a verb emitting the registry's own
 * doc would import the registry that imports it (a cycle). So this is a
 * generator (the `gen-*` + `*-fresh.test.ts` idiom), not a registered verb.
 */

import {
  toInputJsonSchema,
  toOutputJsonSchema,
  verbToken,
  type JsonSchema,
  type Registry,
} from "@bounded-systems/verbspec";

import { verbRegistry } from "./verb-registry.ts";

/**
 * Surface-contract version — bump deliberately on a breaking change to the verb
 * surface. Intentionally decoupled from the package release version so the
 * generated doc does not churn on every changeset bump.
 */
export const OPENAPI_SURFACE_VERSION = "1.0.0";

export type OpenApiDocument = {
  openapi: "3.1.0";
  info: { title: string; version: string; description: string };
  paths: Record<string, unknown>;
  components: { schemas: Record<string, unknown> };
};

/** A verb id → its OpenAPI path: `plan save` → `/plan/save`. */
const verbPath = (id: string): string => `/${id.split(" ").join("/")}`;

/** Drop the redundant JSON Schema dialect marker; OpenAPI 3.1 *is* 2020-12. */
const withoutDialect = (schema: JsonSchema): JsonSchema => {
  const rest: Record<string, unknown> = { ...schema };
  delete rest.$schema;
  return rest as JsonSchema;
};

const ref = (name: string): { $ref: string } => ({ $ref: `#/components/schemas/${name}` });
const jsonBody = (schema: JsonSchema | { $ref: string }): { content: Record<string, unknown> } => ({
  content: { "application/json": { schema } },
});

const byKey = ([a]: [string, unknown], [b]: [string, unknown]): number =>
  a < b ? -1 : a > b ? 1 : 0;

/**
 * Assemble the OpenAPI document from a verb registry. Each verb's input/output
 * is hoisted into `components/schemas` and the operation `$ref`s it; paths and
 * components are sorted so the artifact is deterministic regardless of registry
 * order. A verb whose Zod schema `z.toJSONSchema` can't represent (e.g.
 * `z.date()`) must not sink the whole doc — its operation is emitted inline with
 * `x-prx-unprojectable` and contributes no component (the "honest health" rule).
 */
export function buildOpenApiDocument(registry: Registry = verbRegistry): OpenApiDocument {
  const operations: Array<[string, unknown]> = [];
  const schemas: Record<string, JsonSchema> = {};
  for (const v of Object.values(registry)) {
    const token = verbToken(v.id);
    const path = verbPath(v.id);
    try {
      schemas[`${token}Input`] = withoutDialect(toInputJsonSchema(v));
      schemas[`${token}Output`] = withoutDialect(toOutputJsonSchema(v));
      operations.push([
        path,
        {
          post: {
            operationId: token,
            summary: v.summary,
            "x-prx-actor": v.actor,
            requestBody: { required: true, ...jsonBody(ref(`${token}Input`)) },
            responses: { "200": { description: "ok", ...jsonBody(ref(`${token}Output`)) } },
          },
        },
      ]);
    } catch (e) {
      // One verb whose schema can't project must not sink the whole doc — emit
      // the operation shell inline and surface the gap via x-prx-unprojectable.
      const reason = e instanceof Error ? e.message : String(e);
      operations.push([
        path,
        {
          post: {
            operationId: token,
            summary: v.summary,
            "x-prx-actor": v.actor,
            "x-prx-unprojectable": reason,
            requestBody: { required: true, ...jsonBody({}) },
            responses: { "200": { description: "ok", ...jsonBody({}) } },
          },
        },
      ]);
    }
  }
  operations.sort(byKey);
  return {
    openapi: "3.1.0",
    info: {
      title: "prx — verb surface",
      version: OPENAPI_SURFACE_VERSION,
      description:
        "OpenAPI projection of the prx VerbSpec registry (verbspec's HTTP surface). " +
        "Generated from the Zod verb specs — edit the verbs, not this file.",
    },
    paths: Object.fromEntries(operations),
    components: { schemas: Object.fromEntries(Object.entries(schemas).sort(byKey)) },
  };
}

/** The exact committed bytes: pretty JSON + trailing newline (matches the schema artifacts). */
export function renderOpenApiDocument(registry?: Registry): string {
  return `${JSON.stringify(buildOpenApiDocument(registry), null, 2)}\n`;
}
