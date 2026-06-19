/**
 * OpenAPI projection of the prx VerbSpec registry — verbspec's fourth surface
 * (CLI / MCP / Anthropic / OpenAPI). The verb registry is the single source;
 * this assembles every verb's `toOpenApiOperation` into one OpenAPI 3.1 document.
 *
 * Generated to `packages/prx/openapi.json` by `scripts/gen-openapi.ts` and
 * drift-gated by `test/cli/openapi.test.ts` — edit the verbs, never the JSON.
 *
 * Deliberately NOT a verb in the registry: a verb that emits the registry's own
 * OpenAPI doc would import the registry that imports it (a cycle). So this is a
 * generator (the `gen-*` + `*-fresh.test.ts` idiom), not a registered verb.
 */

import { toOpenApiOperation, verbToken, type Registry } from "@bounded-systems/verbspec";

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
};

/** A verb id → its OpenAPI path: `plan save` → `/plan/save`. */
const verbPath = (id: string): string => `/${id.split(" ").join("/")}`;

/**
 * Assemble the OpenAPI document from a verb registry. Paths are sorted so the
 * artifact is deterministic regardless of registry insertion order. One verb
 * whose Zod schema `z.toJSONSchema` can't represent (e.g. `z.date()`) must not
 * sink the whole doc — its operation shell is still emitted and the gap is
 * surfaced honestly via `x-prx-unprojectable` (the repo's "honest health" rule).
 */
export function buildOpenApiDocument(registry: Registry = verbRegistry): OpenApiDocument {
  const entries: Array<[string, unknown]> = [];
  for (const v of Object.values(registry)) {
    const path = verbPath(v.id);
    try {
      entries.push([path, { post: toOpenApiOperation(v) }]);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      entries.push([
        path,
        {
          post: {
            operationId: verbToken(v.id),
            summary: v.summary,
            "x-prx-actor": v.actor,
            "x-prx-unprojectable": reason,
            requestBody: { required: true, content: { "application/json": { schema: {} } } },
            responses: {
              "200": { description: "ok", content: { "application/json": { schema: {} } } },
            },
          },
        },
      ]);
    }
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    openapi: "3.1.0",
    info: {
      title: "prx — verb surface",
      version: OPENAPI_SURFACE_VERSION,
      description:
        "OpenAPI projection of the prx VerbSpec registry (verbspec's HTTP surface). " +
        "Generated from the Zod verb specs — edit the verbs, not this file.",
    },
    paths: Object.fromEntries(entries),
  };
}

/** The exact committed bytes: pretty JSON + trailing newline (matches the schema artifacts). */
export function renderOpenApiDocument(registry?: Registry): string {
  return `${JSON.stringify(buildOpenApiDocument(registry), null, 2)}\n`;
}
