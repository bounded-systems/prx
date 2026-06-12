import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { defineVerb, parseArgs } from "./index.ts";

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

// A variadic (array-typed) positional collects every positional value, merged
// with same-name flag occurrences — `cmd resolve a b --id c`-style verbs.
const variadic = defineVerb({
  id: "variadic-probe",
  summary: "test-only verb with a variadic positional",
  actor: "work",
  positionals: ["ids"],
  input: z.object({ ids: z.array(z.string()).default([]) }),
  output: z.object({}),
  run: () => ({}),
});

const ids = (argv: string[]) => (parseArgs(variadic, argv) as { ids: string[] }).ids;

describe("parseArgs variadic positionals", () => {
  test("collects all positional values", () => {
    expect(ids(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  test("merges positionals ahead of same-name flag occurrences", () => {
    expect(ids(["a", "b", "--ids", "c"])).toEqual(["a", "b", "c"]);
  });

  test("flag-only still works", () => {
    expect(ids(["--ids", "a", "--ids", "b"])).toEqual(["a", "b"]);
  });

  test("comma-splits positional values too", () => {
    expect(ids(["a,b", "c"])).toEqual(["a", "b", "c"]);
  });

  test("empty when nothing is given", () => {
    expect(ids([])).toEqual([]);
  });
});
