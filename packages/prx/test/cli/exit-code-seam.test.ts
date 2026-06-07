import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { defineVerb } from "../../src/cli/verbspec.ts";
import { runSpecVerb } from "../../src/cli/orchestrator-cli.ts";
import { verbRegistry } from "../../src/cli/verb-registry.ts";

// The `exitCode` projection: a *successful* run can still map its output to a
// non-zero CLI exit (refusal / drift), while MCP/OpenAPI ignore it. Exercised
// against a throwaway verb registered into the shared registry for the test.

describe("VerbSpec exitCode projection", () => {
  const probe = defineVerb({
    id: "exit-code-probe",
    summary: "test-only verb exercising the exitCode seam",
    actor: "work",
    input: z.object({ code: z.coerce.number().default(0) }),
    output: z.object({ code: z.number() }),
    run: ({ code }) => ({ code }),
    render: (out) => `code=${out.code}`,
    exitCode: (out) => out.code,
  });

  test("maps successful output to a non-zero exit code", async () => {
    (verbRegistry as Record<string, unknown>)[probe.id] = probe;
    try {
      const logs: string[] = [];
      const out = { log: (l: string) => logs.push(l), error: () => {} };
      expect(await runSpecVerb("exit-code-probe", ["--code", "0"], out)).toBe(0);
      expect(await runSpecVerb("exit-code-probe", ["--code", "3"], out)).toBe(3);
      expect(logs).toEqual(["code=0", "code=3"]);
    } finally {
      delete (verbRegistry as Record<string, unknown>)[probe.id];
    }
  });

  test("defaults to exit 0 when a verb declares no exitCode", async () => {
    const noExit = defineVerb({
      id: "exit-code-probe",
      summary: "no exitCode",
      actor: "work",
      input: z.object({}),
      output: z.object({}),
      run: () => ({}),
      render: () => "ok",
    });
    (verbRegistry as Record<string, unknown>)[noExit.id] = noExit;
    try {
      const out = { log: () => {}, error: () => {} };
      expect(await runSpecVerb("exit-code-probe", [], out)).toBe(0);
    } finally {
      delete (verbRegistry as Record<string, unknown>)[noExit.id];
    }
  });
});
