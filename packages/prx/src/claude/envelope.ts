// Canonical parser for `claude --print --output-format json` stdout (GH-1095).
//
// `claude` ships two wire shapes for this flag and we have to accept both:
//
//   Old shape (CLI < 2.1):
//     { type: "result", subtype?: ..., result: "<assistant text>",
//       total_cost_usd?: number, is_error?: boolean, ... }
//
//   New shape (CLI ≥ 2.1):
//     [
//       { type: "system",   ... },
//       { type: "assistant", ... },
//       ...
//       { type: "result", subtype: "success", is_error: false,
//         result: "<assistant text>", total_cost_usd?: number, ... }
//     ]
//
// The fix landed first in `notion_claude_mcp.parseClaudeResult` (#667) but the
// triage verbs (`prx triage type-pass`, `prx triage prioritize-bulk`) shipped
// with the old single-shape parser and broke on every row once the local CLI
// rolled forward (GH-1095). This module is the single boundary-layer codec —
// per memory `reference_zod_boundary_layer`, all three callers route through
// here.

import { z } from "zod";

const claudeResultEventSchema = z
  .object({
    type: z.literal("result"),
    result: z.string().optional(),
    is_error: z.boolean().optional(),
    error: z.unknown().optional(),
    total_cost_usd: z.number().nonnegative().optional(),
  })
  .passthrough();

const claudeStreamEventSchema = z.object({ type: z.string() }).passthrough();

const claudeEnvelopeSchema = z.union([claudeResultEventSchema, z.array(claudeStreamEventSchema)]);

export type ClaudeEnvelope = {
  /** The assistant's reply text — the JSON-or-prose payload Claude produced. */
  result: string;
  /** `total_cost_usd` from the terminal result event, when present. */
  costUsd?: number;
};

/**
 * Parse a `claude --print --output-format json` stdout payload and return
 * the assistant's reply text plus optional cost.
 *
 * Throws (with `errorPrefix` prepended) when:
 *   - stdout is not JSON
 *   - the array form has no terminal `{type: "result"}` event
 *   - the result event sets `is_error: true` or `error`
 *   - the result event is missing a string `result` field
 *
 * Callers handle inner-payload parsing (code-fence stripping, schema
 * validation of the JSON the assistant emitted) — that's a per-verb concern,
 * not an envelope concern.
 */
export function parseClaudeJsonEnvelope(
  stdout: string,
  errorPrefix = "claude envelope",
): ClaudeEnvelope {
  let outer: unknown;
  try {
    outer = JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `${errorPrefix}: could not parse claude --output-format json stdout (${(error as Error).message}). stdout was: ${stdout.slice(0, 200)}`,
    );
  }

  const parsed = claudeEnvelopeSchema.safeParse(outer);
  if (!parsed.success) {
    throw new Error(
      `${errorPrefix}: claude stdout did not match envelope schema: ${parsed.error.message}`,
    );
  }

  let event: z.infer<typeof claudeResultEventSchema>;
  if (Array.isArray(parsed.data)) {
    let found: z.infer<typeof claudeResultEventSchema> | null = null;
    for (let i = parsed.data.length - 1; i >= 0; i--) {
      const entry = parsed.data[i];
      if (entry?.type === "result") {
        const eventParsed = claudeResultEventSchema.safeParse(entry);
        if (!eventParsed.success) {
          throw new Error(
            `${errorPrefix}: malformed result event in stream-JSON: ${eventParsed.error.message}`,
          );
        }
        found = eventParsed.data;
        break;
      }
    }
    if (!found) {
      const types = parsed.data.map((e: { type: string }) => e.type).join(",");
      throw new Error(
        `${errorPrefix}: claude stream-JSON output had no terminal "result" event (types: ${types}). stdout was: ${stdout.slice(0, 300)}`,
      );
    }
    event = found;
  } else {
    event = parsed.data;
  }

  if (event.is_error || event.error) {
    throw new Error(
      `${errorPrefix}: claude returned an error envelope: ${JSON.stringify(event).slice(0, 300)}`,
    );
  }
  if (typeof event.result !== "string") {
    throw new Error(
      `${errorPrefix}: missing string "result" field in result event: ${JSON.stringify(event).slice(0, 300)}`,
    );
  }

  return typeof event.total_cost_usd === "number"
    ? { result: event.result, costUsd: event.total_cost_usd }
    : { result: event.result };
}
