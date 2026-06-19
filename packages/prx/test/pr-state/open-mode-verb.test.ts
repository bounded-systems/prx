import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openModeVerb, type OpenModeOutput } from "../../src/pr-state/open-mode-verb.ts";

// `prx open-mode` migrated off cli.ts to a spec-driven VerbSpec (ADR
// docs/prx/cli-decomposition.md). These cover run + render at the verb
// boundary; routing/exit codes are exercised end-to-end through the compiled
// CLI in cli.test.ts.

function makeContractFile(state: string, ready: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "open-mode-verb-"));
  const contractPath = join(dir, "pr.json");
  writeFileSync(
    contractPath,
    JSON.stringify({
      pr: {
        title: "Open Mode Verb Example",
        ready: { value: ready, reason: null, checked_by: null, notes: [] },
        lifecycle: { state, updated_by: null, reason: null, notes: [] },
      },
    }),
  );
  return contractPath;
}

const run = (input: { contract: string; format: string; pr?: string }): string =>
  (openModeVerb.run(input as never) as OpenModeOutput).rendered;

describe("open-mode verb", () => {
  test("mode emits the bare open mode", () => {
    expect(run({ contract: makeContractFile("drafting", false), format: "mode" })).toBe("draft");
  });

  test("json emits the derived info object", () => {
    const parsed = JSON.parse(
      run({ contract: makeContractFile("drafting", false), format: "json" }),
    );
    expect(parsed).toMatchObject({ mode: "draft", state: "drafting" });
  });

  test("gh-create emits the gh pr create command", () => {
    expect(run({ contract: makeContractFile("drafting", false), format: "gh-create" })).toBe(
      "gh pr create --draft",
    );
  });

  test("gh-ready returns the gh pr ready command for a pr ref", () => {
    const contract = makeContractFile("ready_for_review", true);
    expect(run({ contract, format: "gh-ready", pr: "123" })).toBe("gh pr ready 123");
  });

  test("gh-ready throws without a pr ref", () => {
    const contract = makeContractFile("ready_for_review", true);
    expect(() => run({ contract, format: "gh-ready" })).toThrow(
      "--pr is required with --format gh-ready",
    );
  });

  test("render returns the raw rendered text", () => {
    const contract = makeContractFile("drafting", false);
    const out = openModeVerb.run({ contract, format: "mode" } as never) as OpenModeOutput;
    expect(openModeVerb.render!(out, { contract, format: "mode" } as never)).toBe(out.rendered);
  });
});
