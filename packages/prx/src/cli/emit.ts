/**
 * Universal structured-result printer (prx-9kd).
 *
 * Every command should produce ONE structured value — JSON under
 * `--format json`, pretty-printed for humans by default. Today cli.ts hand-rolls
 * that fork in ~118 places (`if (parsed.format === "json") { JSON.stringify… }
 * else { … }`), each deciding the shape twice. This is the one place that owns
 * json-vs-pretty, so a handler emits a `{ data, pretty }` pair and is done:
 *
 *     emit(output, result(payload, renderPayload), parsed.format);
 *
 * The contract: `data` is the machine surface (stable, the `--json` output);
 * `pretty(data)` is the human surface derived from it. They never drift because
 * pretty is a pure function of data.
 */

import type { z } from "zod";

/** Minimal sink — structurally compatible with cli.ts's `Output`. */
export type OutputSink = { log: (line: string) => void };

export type OutputFormat = "plain" | "json";

export interface CliResult<T> {
  /**
   * The Zod contract for `data` — the `--json` surface IS this schema. Required
   * even for trivial results: the machine output is a validated guarantee, not
   * an ad-hoc object, and the schema is the documented contract (prx-9kd).
   */
  schema: z.ZodType<T>;
  /** The structured payload — validated against `schema`, printed under `--json`. */
  data: T;
  /** The human render, a pure function of `data` (the default/plain output). */
  pretty: (data: T) => string;
}

/** Build a {@link CliResult} inline. */
export function result<T>(
  schema: z.ZodType<T>,
  data: T,
  pretty: (data: T) => string,
): CliResult<T> {
  return { schema, data, pretty };
}

/**
 * Emit a structured result: it is validated against its schema, then printed as
 * pretty JSON under `format === "json"` or via `pretty` otherwise. The single
 * json-vs-human decision point for the CLI — and the single validation boundary.
 */
export function emit<T>(
  output: OutputSink,
  res: CliResult<T>,
  format: OutputFormat,
): void {
  const data = res.schema.parse(res.data);
  output.log(
    format === "json" ? JSON.stringify(data, null, 2) : res.pretty(data),
  );
}
