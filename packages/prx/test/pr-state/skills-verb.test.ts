import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { skillsVerb, type SkillsOutput } from "../../src/pr-state/skills-verb.ts";

// `prx skills` migrated off cli.ts to a spec-driven VerbSpec (ADR
// docs/prx/cli-decomposition.md). These cover run + render at the verb
// boundary; the routing is also exercised end-to-end through the compiled CLI.

function makeContractFile(state: string, ready: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "skills-verb-"));
  const contractPath = join(dir, "pr.json");
  writeFileSync(
    contractPath,
    JSON.stringify({
      pr: {
        title: "Skills Verb Example",
        ready: { value: ready, reason: null, checked_by: null, notes: [] },
        lifecycle: { state, updated_by: null, reason: null, notes: [] },
      },
    }),
  );
  return contractPath;
}

const run = (contract: string, format: "plain" | "json"): string =>
  (skillsVerb.run({ contract, format } as never) as SkillsOutput).rendered;

describe("skills verb", () => {
  test("plain output lists the catalog gated by the contract state", () => {
    const out = run(makeContractFile("drafting", false), "plain");
    expect(out).toContain("pr skill catalog");
    expect(out).toContain("current state: drafting");
    expect(out).toContain("pr-validate -> SKILL_VALIDATE -> validating (allowed=yes)");
    expect(out).toContain("pr-contract -> SKILL_CONTRACT (observe)");
  });

  test("json output reflects the current state and skill events", () => {
    const parsed = JSON.parse(run(makeContractFile("ready_for_review", true), "json")) as {
      currentState: string;
      skills: Array<{ skill: string; event: string; kind: string }>;
    };
    expect(parsed.currentState).toBe("ready_for_review");
    expect(parsed.skills.find((s) => s.skill === "pr-contract")).toMatchObject({
      skill: "pr-contract",
      event: "SKILL_CONTRACT",
      kind: "observe",
    });
  });

  test("render returns the raw catalog text", () => {
    const contract = makeContractFile("drafting", false);
    const out = skillsVerb.run({ contract, format: "plain" } as never) as SkillsOutput;
    expect(skillsVerb.render!(out, { contract, format: "plain" } as never)).toBe(out.rendered);
  });
});
