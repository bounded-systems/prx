import { describe, expect, test } from "bun:test";

import { actorsVerb, type CatalogOutput, modelVerb } from "../../src/pr-state/model-verb.ts";
import type { VerbSpec } from "@bounded-systems/verbspec";

// The `actors` / `model` catalog reads migrated off cli.ts to spec-driven
// VerbSpecs (ADR docs/prx/cli-decomposition.md). These cover scope × format at
// the verb boundary (run + render); routing (`actors`, `model`, `model actors`,
// `model show`) is exercised end-to-end through the compiled CLI.

const run = (
  verb: VerbSpec,
  input: { scope: "pr" | "workflow"; format: "plain" | "json" },
): string => (verb.run(input as never) as CatalogOutput).rendered;

describe("actors verb", () => {
  test("plain output lists pr-scope tool actors", () => {
    const out = run(actorsVerb, { scope: "pr", format: "plain" });
    expect(out).toContain("Tool actors (pr)");
    expect(out).toContain("git (cli)");
    expect(out).toContain("tier: execution");
    expect(out).toContain("gh (api_cli)");
    expect(out).toContain("local_ci (local_runner)");
    expect(out).not.toContain("notion_mcp");
  });

  test("json output enumerates the pr-scope actor set", () => {
    const parsed = JSON.parse(run(actorsVerb, { scope: "pr", format: "json" })) as {
      scope: string;
      actors: Array<{ actor: string }>;
    };
    expect(parsed.scope).toBe("pr");
    expect(parsed.actors.map((a) => a.actor).sort()).toEqual([
      "doctor",
      "gh",
      "git",
      "keeper",
      "local_ci",
      "mediator",
      "prx",
      "publisher",
      "remote_ci",
      "wt",
    ]);
  });

  test("workflow scope adds the workflow-only actors", () => {
    const parsed = JSON.parse(run(actorsVerb, { scope: "workflow", format: "json" })) as {
      scope: string;
      actors: Array<{ actor: string }>;
    };
    expect(parsed.scope).toBe("workflow");
    const names = parsed.actors.map((a) => a.actor);
    expect(names).toContain("notion_mcp");
    expect(names).toContain("beads");
    expect(names).toContain("llm_agent");
  });

  test("render returns the raw catalog text", () => {
    const out = actorsVerb.run({ scope: "pr", format: "plain" } as never) as CatalogOutput;
    expect(actorsVerb.render!(out, { scope: "pr", format: "plain" } as never)).toBe(out.rendered);
  });
});

describe("model verb", () => {
  test("plain output describes the pr model", () => {
    const out = run(modelVerb, { scope: "pr", format: "plain" });
    expect(out).toContain("Model (pr)");
    expect(out).toContain("actors -> owned raw facts -> invariants -> derived phase");
    expect(out).toContain("ready_to_merge");
  });

  test("json output exposes owners and the workflow backbone", () => {
    const parsed = JSON.parse(run(modelVerb, { scope: "workflow", format: "json" })) as {
      scope: string;
      actors: Array<{ actor: string }>;
      rawFieldOwners: Record<string, string>;
      eventOwners: Record<string, string>;
      workflowBackbone?: { id?: string };
    };
    expect(parsed.scope).toBe("workflow");
    expect(parsed.actors.map((a) => a.actor)).toContain("beads");
    expect(parsed.rawFieldOwners["task.id"]).toBe("beads");
    expect(parsed.eventOwners["TASK_CREATED"]).toBe("beads");
    expect(parsed.eventOwners["WORKTREE_CREATED"]).toBe("wt");
    expect(parsed.eventOwners["REMOTE_BRANCH_PUBLISHED"]).toBe("git");
    expect(parsed.eventOwners["PR_READY_FOR_REVIEW"]).toBe("gh");
    expect(parsed.workflowBackbone?.id).toBe("workflowBackbone");
  });
});
