import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { defineVerb, parseArgs } from "../../src/cli/verbspec.ts";

// parseArgs CLI-isms for array-typed input fields: repeated flags accumulate,
// comma-separated values split, and the two forms compose. Scalars take the
// last value. (The Zod schema stays free of CLI quirks; this is the projection.)

const verb = defineVerb({
  id: "args-probe",
  summary: "test-only verb for parseArgs array handling",
  actor: "work",
  input: z.object({
    allow: z.array(z.string()).default([]),
    name: z.string().optional(),
    n: z.coerce.number().default(0),
  }),
  output: z.object({}),
  run: () => ({}),
});

const allow = (argv: string[]) => (parseArgs(verb, argv) as { allow: string[] }).allow;

describe("parseArgs array flags", () => {
  test("repeated flags accumulate", () => {
    expect(allow(["--allow", "a", "--allow", "b"])).toEqual(["a", "b"]);
  });

  test("comma-separated values split", () => {
    expect(allow(["--allow", "a,b,c"])).toEqual(["a", "b", "c"]);
  });

  test("repeated and comma forms compose", () => {
    expect(allow(["--allow", "a,b", "--allow", "c"])).toEqual(["a", "b", "c"]);
  });

  test("--k=v form accumulates too", () => {
    expect(allow(["--allow=a", "--allow=b,c"])).toEqual(["a", "b", "c"]);
  });

  test("empty when the flag is absent (schema default)", () => {
    expect(allow([])).toEqual([]);
  });

  test("scalars still take the last value; arrays don't leak into them", () => {
    const out = parseArgs(verb, ["--name", "x", "--name", "y", "--n", "3"]) as {
      name: string;
      n: number;
    };
    expect(out.name).toBe("y");
    expect(out.n).toBe(3);
  });
});
