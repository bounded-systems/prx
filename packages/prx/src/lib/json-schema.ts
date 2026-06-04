import { z } from "zod";

/**
 * Convert a Zod schema to a Draft-7 JSON Schema artifact in the
 * `{ $ref, definitions: { [name]: ... } }` shape our committed artifacts and
 * downstream `#/definitions/<name>` consumers expect.
 *
 * Replaces `zod-to-json-schema` (Zod-3 only) with Zod 4's built-in
 * `z.toJSONSchema`. The native converter emits the `$schema` keyword on the
 * schema body; it is lifted to the wrapper's top level so the artifact keeps
 * the historical `{ $ref, definitions, $schema }` layout. prx-mt9.
 */
export function toJsonSchemaArtifact(
  schema: z.ZodType,
  name: string,
): Record<string, unknown> {
  const body = z.toJSONSchema(schema, { target: "draft-7" }) as Record<
    string,
    unknown
  >;
  const $schema = body.$schema;
  delete body.$schema;
  return {
    $ref: `#/definitions/${name}`,
    definitions: { [name]: body },
    $schema,
  };
}
