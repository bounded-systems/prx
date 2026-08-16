import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applySkillEvent,
  eventVerb,
  type EventOutput,
  type SkillEventDeps,
} from "../../src/pr-state/event-verb.ts";

// `prx event` migrated off cli.ts to a deps-bearing VerbSpec (ADR
// docs/prx/cli-decomposition.md). These exercise run + render + the shared
// applySkillEvent helper, injecting the git-info deps for determinism; routing
// (`event`, `contract event`) is covered end-to-end by the compiled CLI.

function setup(state: string, ready: boolean): { contract: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "event-verb-"));
  const contract = join(dir, "pr.json");
  writeFileSync(
    contract,
    JSON.stringify({
      pr: {
        title: "Event Verb Example",
        ready: { value: ready, reason: null, checked_by: null, notes: [] },
        lifecycle: { state, updated_by: null, reason: null, notes: [] },
      },
    }),
  );
  return { contract, log: join(dir, "transitions.jsonl") };
}

const fixedDeps: SkillEventDeps = {
  detectBranchNameFromCwd: () => "GH-1",
  tryCommand: () => "abc123def456",
};

const run = (contract: string, format: "plain" | "json", log: string): EventOutput =>
  eventVerb.run(
    { contract, skill: "pr-validate", actor: "prx", format, log } as never,
    fixedDeps,
  ) as EventOutput;

describe("event verb", () => {
  test("applies a transition skill, advances the state, and logs it", () => {
    const { contract, log } = setup("drafting", false);
    const out = run(contract, "plain", log);
    expect(out).toMatchObject({
      skill: "pr-validate",
      event: "SKILL_VALIDATE",
      kind: "transition",
      from: "drafting",
      to: "validating",
      state: "validating",
      transitionApplied: true,
    });
    // the `event` verb appends a transition-log entry on a real transition
    const entry = JSON.parse(readFileSync(log, "utf8").trim());
    expect(entry).toMatchObject({ state_from: "drafting", state_to: "validating", issue: "GH-1" });
  });

  test("records a blocked transition as an observation (no advance)", () => {
    const { contract, log } = setup("merged", true);
    const out = run(contract, "json", log);
    expect(out).toMatchObject({
      kind: "observe",
      from: "merged",
      to: "validating",
      transitionApplied: false,
      blockedTransition: { from: "merged", to: "validating" },
      state: "merged",
    });
  });

  test("render: plain line vs json", () => {
    const { contract, log } = setup("drafting", false);
    const input = { contract, skill: "pr-validate", actor: "prx", format: "plain" as const, log };
    const out = eventVerb.run(input as never, fixedDeps) as EventOutput;
    expect(eventVerb.render!(out, input as never)).toBe(
      "validating (draft) - SKILL_VALIDATE via pr-validate",
    );
    expect(JSON.parse(eventVerb.render!(out, { ...input, format: "json" } as never))).toMatchObject(
      {
        skill: "pr-validate",
        state: "validating",
      },
    );
  });

  test("applySkillEvent with logTransition:false does not write a log (the contract path)", () => {
    const { contract, log } = setup("drafting", false);
    const out = applySkillEvent(
      { contract, skill: "pr-contract", actor: "prx", log },
      { logTransition: false },
      fixedDeps,
    );
    expect(out.skill).toBe("pr-contract");
    expect(() => readFileSync(log, "utf8")).toThrow(); // no log written
  });
});
