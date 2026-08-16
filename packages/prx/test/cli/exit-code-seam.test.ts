import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { defineVerb } from "@bounded-systems/verbspec";
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

describe("VerbSpec warnings projection", () => {
  // A verb's stderr lines (warnings/notes) are written before the stdout result,
  // letting two-stream handlers (plan-save, …) keep their operator warnings.
  const probe = defineVerb({
    id: "warnings-probe",
    summary: "test-only verb exercising the warnings seam",
    actor: "work",
    input: z.object({ noisy: z.coerce.boolean().default(false) }),
    output: z.object({ noisy: z.boolean() }),
    run: ({ noisy }) => ({ noisy }),
    render: () => "result-line",
    warnings: (out) => (out.noisy ? ["warning: one", "note: two"] : []),
  });

  test("writes warnings to stderr before the stdout result", async () => {
    (verbRegistry as Record<string, unknown>)[probe.id] = probe;
    try {
      const logs: string[] = [];
      const errs: string[] = [];
      const out = { log: (l: string) => logs.push(l), error: (e: string) => errs.push(e) };
      expect(await runSpecVerb("warnings-probe", ["--noisy", "true"], out)).toBe(0);
      expect(errs).toEqual(["warning: one", "note: two"]);
      expect(logs).toEqual(["result-line"]);
    } finally {
      delete (verbRegistry as Record<string, unknown>)[probe.id];
    }
  });

  test("emits nothing to stderr when there are no warnings", async () => {
    (verbRegistry as Record<string, unknown>)[probe.id] = probe;
    try {
      const errs: string[] = [];
      const out = { log: () => {}, error: (e: string) => errs.push(e) };
      await runSpecVerb("warnings-probe", [], out);
      expect(errs).toEqual([]);
    } finally {
      delete (verbRegistry as Record<string, unknown>)[probe.id];
    }
  });
});
