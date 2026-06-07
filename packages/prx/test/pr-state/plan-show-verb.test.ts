// `prx plan show` migrated off cli.ts to a deps-bearing VerbSpec (ADR
// docs/prx/cli-decomposition.md). Drives the `run` + `render` surface with an
// injected `runPlanShow`: the show mode (text head-preview ≤20 / >20 lines and
// the full-body json envelope), the `--paths` mode (text + json render), and
// the PlanRefNotFound → `FAIL:` rethrow. Routing is covered by the compiled CLI.

import { describe, expect, test } from "bun:test";

import { planShowVerb, type PlanShowDeps } from "../../src/pr-state/plan-show-verb.ts";
import { PlanRefNotFound } from "../../src/plan-store/verbs.ts";

type ShowInput = { unit?: string; slot?: string; format?: string; paths?: boolean };

const showResult = (body: string) =>
  ({
    unit: "GH-1",
    slot: "draft" as const,
    sha: "sha256:abc",
    size: body.length,
    body: Buffer.from(body),
    validated_ok: true,
    diagnostics: [],
  }) as never;

const deps = (body: string): PlanShowDeps => ({
  runPlanShow: async () => showResult(body),
});

const run = (input: ShowInput, d: PlanShowDeps) =>
  planShowVerb.run(input as never, d) as Promise<never>;
const render = (out: never, input: ShowInput) =>
  planShowVerb.render!(out, input as never);

describe("plan-show verb", () => {
  test("show / text renders a head preview without a 'more lines' note when ≤20 lines", async () => {
    const body = "# Plan\n\n## Scope\n- a\n- b\n";
    const input: ShowInput = { unit: "GH-1", slot: "draft", format: "text" };
    const out = await run(input, deps(body));
    const text = render(out, input);
    expect(text).toContain("unit: GH-1");
    expect(text).toContain("slot: draft");
    expect(text).toContain("sha:  sha256:abc");
    expect(text).toContain("## Scope");
    expect(text).not.toContain("more lines");
  });

  test("show / text truncates to 20 lines and notes the remainder", async () => {
    const body = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const input: ShowInput = { unit: "GH-1", format: "text" };
    const out = await run(input, deps(body));
    const text = render(out, input);
    expect(text).toContain("line 20");
    expect(text).not.toContain("line 21");
    expect(text).toContain("more lines; use --format json");
  });

  test("show / json renders the full body envelope", async () => {
    const body = "# Plan\n\n## Scope\n- everything\n";
    const input: ShowInput = { unit: "GH-1", slot: "approved", format: "json" };
    const out = await run(input, deps(body));
    const parsed = JSON.parse(render(out, input));
    expect(parsed).toMatchObject({ unit: "GH-1", slot: "draft", sha: "sha256:abc", size: body.length });
    expect(parsed.body).toBe(body);
  });

  test("--paths reports the CAS root (text + json) without reading a blob", async () => {
    let showCalls = 0;
    const d: PlanShowDeps = {
      runPlanShow: async () => {
        showCalls += 1;
        return showResult("unused") as never;
      },
    };
    const input: ShowInput = { unit: "GH-1", paths: true, format: "text" };
    const out = await run(input, d);
    expect(showCalls).toBe(0); // --paths never reads a slot
    const text = render(out, input);
    expect(text).toContain("unit:           GH-1");
    expect(text).toContain("domain:         plans");
    expect(text).toContain("cas_root:");

    const json = JSON.parse(render(out, { ...input, format: "json" }));
    expect(json).toMatchObject({ unit: "GH-1", domain: "plans" });
    expect(json).toHaveProperty("cas_root");
    expect(json).toHaveProperty("staging");
  });

  test("PlanRefNotFound is rethrown as a FAIL: message", async () => {
    const d: PlanShowDeps = {
      runPlanShow: async () => {
        throw new PlanRefNotFound("GH-1", "draft");
      },
    };
    await expect(run({ unit: "GH-1", format: "text" }, d)).rejects.toThrow(/FAIL: no plan blob for GH-1/);
  });

  test("a non-PlanRefNotFound error propagates unchanged", async () => {
    const d: PlanShowDeps = {
      runPlanShow: async () => {
        throw new Error("disk on fire");
      },
    };
    await expect(run({ unit: "GH-1", format: "text" }, d)).rejects.toThrow(/disk on fire/);
  });
});
