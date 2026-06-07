import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { statusVerb, type StatusOutput } from "../../src/pr-state/status-verb.ts";

// `prx status` migrated off cli.ts to a spec-driven VerbSpec (ADR
// docs/prx/cli-decomposition.md), backed by the status-report leaf. These cover
// run + render at the verb boundary; routing and the missing-contract ENOENT
// hint are exercised end-to-end through the compiled CLI in cli.test.ts.

function makeContractFile(state: string, ready: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "status-verb-"));
  const contractPath = join(dir, "pr.json");
  writeFileSync(
    contractPath,
    JSON.stringify({
      pr: {
        title: "Status Verb Example",
        ready: { value: ready, reason: null, checked_by: null, notes: [] },
        lifecycle: { state, updated_by: null, reason: null, notes: [] },
      },
    }),
  );
  return contractPath;
}

const run = (contract: string, format: "plain" | "mode" | "json"): string =>
  (statusVerb.run({ contract, format } as never) as StatusOutput).rendered;

describe("status verb", () => {
  test("plain output renders the state (mode) line", () => {
    expect(run(makeContractFile("drafting", false), "plain")).toBe("drafting (draft)");
  });

  test("mode output renders the bare mode", () => {
    expect(run(makeContractFile("ready_for_review", true), "mode")).toBe("ready");
  });

  test("json output renders the derived info", () => {
    const parsed = JSON.parse(run(makeContractFile("ready_for_review", true), "json"));
    expect(parsed).toMatchObject({
      mode: "ready",
      state: "ready_for_review",
      title: "Status Verb Example",
    });
  });

  test("render returns the raw rendered text", () => {
    const out: StatusOutput = { rendered: "drafting (draft)" };
    expect(statusVerb.render!(out, { contract: "x", format: "plain" } as never)).toBe(
      "drafting (draft)",
    );
  });
});
