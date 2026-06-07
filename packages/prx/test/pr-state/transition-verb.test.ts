import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  transitionVerb,
  type TransitionDeps,
  type TransitionOutput,
} from "../../src/pr-state/transition-verb.ts";

// `prx transition` migrated off cli.ts to a deps-bearing VerbSpec (ADR
// docs/prx/cli-decomposition.md). These exercise run + render at the verb
// boundary, injecting the git-info deps (branch / commit) for determinism;
// routing and exit codes are covered end-to-end by the compiled CLI.

function setup(state: string, ready: boolean): { contract: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "transition-verb-"));
  const contract = join(dir, "pr.json");
  writeFileSync(
    contract,
    JSON.stringify({
      pr: {
        title: "Transition Verb Example",
        ready: { value: ready, reason: null, checked_by: null, notes: [] },
        lifecycle: { state, updated_by: null, reason: null, notes: [] },
      },
    }),
  );
  return { contract, log: join(dir, "transitions.jsonl") };
}

const fixedDeps: TransitionDeps = {
  detectBranchNameFromCwd: () => "GH-1",
  tryCommand: () => "abc123def456",
};

const baseInput = {
  actor: "pr-prime",
  format: "plain" as const,
  log: ".prx/transitions.jsonl",
};

describe("transition verb", () => {
  test("applies the transition, writes the contract, and appends a log entry", () => {
    const { contract, log } = setup("drafting", false);
    const out = transitionVerb.run(
      { ...baseInput, contract, to: "validating", reason: "Checklist complete", log, id: "fixed-id" } as never,
      fixedDeps,
    ) as TransitionOutput;

    // contract updated on disk
    const next = JSON.parse(readFileSync(contract, "utf8"));
    expect(next.pr.lifecycle.state).toBe("validating");

    // structured output
    expect(out).toMatchObject({
      state: "validating",
      mode: "draft",
      transition: { to: "validating", actor: "pr-prime", reason: "Checklist complete" },
    });

    // log entry written with the injected branch/commit
    const entry = JSON.parse(readFileSync(log, "utf8").trim());
    expect(entry).toMatchObject({
      id: "fixed-id",
      issue: "GH-1",
      state_from: "drafting",
      state_to: "validating",
      actor: "pr-prime",
      artifact: "branch:GH-1",
      proof: { commit: "abc123def456" },
    });
  });

  test("json render emits the structured transition result", () => {
    const { contract, log } = setup("drafting", false);
    const input = { ...baseInput, contract, to: "validating", reason: "done", log, format: "json" as const };
    const out = transitionVerb.run(input as never, fixedDeps) as TransitionOutput;
    const rendered = transitionVerb.render!(out, input as never);
    expect(JSON.parse(rendered)).toMatchObject({
      state: "validating",
      mode: "draft",
      transition: { to: "validating", actor: "pr-prime", reason: "done" },
    });
  });

  test("plain render returns the refreshed status line of the written contract", () => {
    const { contract, log } = setup("drafting", false);
    const input = { ...baseInput, contract, to: "validating", log };
    const out = transitionVerb.run(input as never, fixedDeps) as TransitionOutput;
    expect(transitionVerb.render!(out, input as never)).toContain("validating (draft)");
  });

  test("an invalid transition throws a FAIL-prefixed error and does not write", () => {
    const { contract, log } = setup("drafting", false);
    const before = readFileSync(contract, "utf8");
    expect(() =>
      transitionVerb.run({ ...baseInput, contract, to: "merged", log } as never, fixedDeps),
    ).toThrow("FAIL: invalid transition from `drafting` to `merged`");
    expect(readFileSync(contract, "utf8")).toBe(before);
  });

  test("declares a default deps slice", () => {
    expect(typeof transitionVerb.deps).toBe("function");
    const real = transitionVerb.deps!();
    expect(typeof real.detectBranchNameFromCwd).toBe("function");
    expect(typeof real.tryCommand).toBe("function");
  });
});
