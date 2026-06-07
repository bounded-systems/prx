import { describe, expect, test } from "bun:test";

import {
  planLoadVerb,
  type PlanLoadDeps,
} from "../../src/pr-state/plan-load-verb.ts";

// `prx plan load` migrated off cli.ts to a deps-bearing VerbSpec (ADR
// docs/prx/cli-decomposition.md). Covers the raw (Buffer) vs json render, the
// approved→draft fallback note (warnings projection), and that run threads the
// fallback flag. Routing is covered by the compiled CLI.

const body = Buffer.from("# Plan\n\n## Scope\n- do it\n");

const deps = (
  over: Partial<{ fellBackToDraft: boolean }> = {},
  rec?: { fallbackToDraft?: boolean },
): PlanLoadDeps => ({
  runPlanLoad: async ({ slot, fallbackToDraft }) => {
    if (rec) rec.fallbackToDraft = fallbackToDraft;
    return {
      slot: over.fellBackToDraft ? "draft" : (slot as "draft" | "approved"),
      sha: "sha256:abc",
      content: body,
      fellBackToDraft: over.fellBackToDraft ?? false,
    } as never;
  },
});

const run = (input: { unit?: string; slot?: "draft" | "approved"; format: "raw" | "json" }, d: PlanLoadDeps) =>
  planLoadVerb.run(input as never, d) as Promise<never>;

describe("plan-load verb", () => {
  test("raw format renders the exact body Buffer (no trailing newline)", async () => {
    const out = await run({ unit: "GH-1", slot: "approved", format: "raw" }, deps());
    const raw = planLoadVerb.renderRaw!(out, { unit: "GH-1", slot: "approved", format: "raw" } as never);
    expect(Buffer.isBuffer(raw)).toBe(true);
    expect((raw as Buffer).equals(body)).toBe(true);
  });

  test("json format renders an envelope (renderRaw defers with null)", async () => {
    const input = { unit: "GH-1", slot: "approved", format: "json" as const };
    const out = await run(input, deps());
    expect(planLoadVerb.renderRaw!(out, input as never)).toBeNull();
    expect(JSON.parse(planLoadVerb.render!(out, input as never))).toMatchObject({
      unit: "GH-1",
      slot: "approved",
      sha: "sha256:abc",
      size: body.length,
    });
  });

  test("omitting --slot falls back approved→draft and notes it on stderr", async () => {
    const input = { unit: "GH-1", format: "raw" as const };
    const rec: { fallbackToDraft?: boolean } = {};
    const out = await run(input, deps({ fellBackToDraft: true }, rec));
    expect(rec.fallbackToDraft).toBe(true); // requested when --slot is omitted
    expect(planLoadVerb.warnings!(out, input as never)).toEqual([
      "note: no approved plan for GH-1, falling back to draft (sha=sha256:abc)",
    ]);
  });

  test("explicit --slot does not request fallback and emits no warning", async () => {
    const input = { unit: "GH-1", slot: "draft" as const, format: "raw" as const };
    const rec: { fallbackToDraft?: boolean } = {};
    const out = await run(input, deps({}, rec));
    expect(rec.fallbackToDraft).toBe(false);
    expect(planLoadVerb.warnings!(out, input as never)).toEqual([]);
  });
});
