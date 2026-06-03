/**
 * prx-9kd — the universal structured-result printer. One place owns json-vs-
 * pretty; `pretty` is a pure function of `data`, so the two surfaces never drift.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { type CliResult, emit, result } from "../../src/cli/emit.ts";

function sink(): { lines: string[]; log: (l: string) => void } {
  const lines: string[] = [];
  return { lines, log: (l) => lines.push(l) };
}

// Even a trivial result carries a schema — the `--json` surface is a contract.
const greetingSchema = z.object({ name: z.string(), n: z.number().int() });
const greeting: CliResult<z.infer<typeof greetingSchema>> = result(
  greetingSchema,
  { name: "ana", n: 3 },
  (d) => `hi ${d.name} (${d.n})`,
);

describe("emit (prx-9kd)", () => {
  test("json format prints the structured data as pretty JSON", () => {
    const out = sink();
    emit(out, greeting, "json");
    expect(JSON.parse(out.lines[0]!)).toEqual({ name: "ana", n: 3 });
  });

  test("plain format prints the pretty render", () => {
    const out = sink();
    emit(out, greeting, "plain");
    expect(out.lines).toEqual(["hi ana (3)"]);
  });

  test("emit validates data against its schema (the json surface is a guarantee)", () => {
    const out = sink();
    expect(() =>
      emit(
        out,
        // n must be an int; a bad payload is rejected at the boundary.
        { schema: greetingSchema, data: { name: "x", n: 1.5 }, pretty: () => "x" },
        "json",
      ),
    ).toThrow();
  });

  test("pretty is a pure function of (validated) data", () => {
    const out = sink();
    emit(out, result(z.object({ x: z.number() }), { x: 1 }, (d) => `x=${d.x}`), "plain");
    expect(out.lines).toEqual(["x=1"]);
  });
});
