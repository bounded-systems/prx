import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { defineVerb } from "@bounded-systems/verbspec";
import {
  READ_ONLY,
  pluginAllowedTools,
  toCliPermissionFlags,
  verbToolPolicy,
} from "./permissions.ts";
import { toClaudePlugin } from "./claude-plugin.ts";
import { pilotVerb } from "./pilot-verbs.ts";

const unknownActorVerb = defineVerb({
  id: "mystery",
  summary: "verb with an actor that has no policy",
  actor: "nobody",
  input: z.object({}),
  output: z.object({}),
  run: () => ({}),
});

describe("permission projection (actor → tool policy on every surface)", () => {
  test("the policy comes from the verb's actor; unknown actors are read-only", () => {
    const p = verbToolPolicy(pilotVerb);
    expect(p.allow).toContain("Bash(prx:*)");
    expect(p.deny).toContain("Write"); // orchestrator never mutates directly
    expect(verbToolPolicy(unknownActorVerb)).toEqual(READ_ONLY);
  });

  test("CLI flag-layer projection matches the runtime-profile flag shape", () => {
    const flags = toCliPermissionFlags(pilotVerb);
    expect(flags).toContain("--allowedTools");
    expect(flags[flags.indexOf("--allowedTools") + 1]).toContain("Bash(prx:*)");
    expect(flags).toContain("--disallowedTools");
  });

  test("plugin allowed-tools = the verb's own MCP tool + the actor's allow list", () => {
    const allowed = pluginAllowedTools(pilotVerb, "mcp__prx__pilot");
    expect(allowed[0]).toBe("mcp__prx__pilot");
    expect(allowed).toContain("Bash(prx:*)");
    expect(allowed).not.toContain("Write"); // deny enforced by omission
  });

  test("the plugin projection wires the policy into each command's frontmatter", () => {
    const files = toClaudePlugin({ [pilotVerb.id]: pilotVerb });
    const cmd = files.find((f) => f.path === "commands/prx-pilot.md")!;
    expect(cmd.content).toContain("allowed-tools: mcp__prx__pilot, Read, Grep, Glob, Bash(prx:*)");
  });

  test("custom policies override the defaults end to end", () => {
    const files = toClaudePlugin(
      { [pilotVerb.id]: pilotVerb },
      { policies: { pilot: { allow: ["Read"], deny: [] } } },
    );
    const cmd = files.find((f) => f.path === "commands/prx-pilot.md")!;
    expect(cmd.content).toContain("allowed-tools: mcp__prx__pilot, Read\n");
  });
});
