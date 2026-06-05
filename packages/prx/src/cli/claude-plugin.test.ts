import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { defineVerb, type Registry } from "./verbspec.ts";
import { mcpToolRef, toClaudePlugin } from "./claude-plugin.ts";
import { fleetVerb, pilotVerb } from "./pilot-verbs.ts";

const find = (files: { path: string; content: string }[], path: string) =>
  files.find((f) => f.path === path);

const reg: Registry = {
  [pilotVerb.id]: pilotVerb,
  [fleetVerb.id]: fleetVerb,
  "plan session": defineVerb({
    id: "plan session",
    summary: "Open a plan-mode session for a unit.",
    actor: "plan",
    positionals: ["unit"],
    input: z.object({ unit: z.string().min(1) }),
    output: z.object({ ok: z.boolean() }),
    run: () => ({ ok: true }),
  }),
};

describe("prx as a Claude Code plugin (projection of the registry)", () => {
  test("emits a manifest + an MCP client config pointing at the separate runtime", () => {
    const files = toClaudePlugin(reg);

    const manifest = find(files, ".claude-plugin/plugin.json")!;
    expect(JSON.parse(manifest.content).name).toBe("prx");

    const mcp = JSON.parse(find(files, ".mcp.json")!.content);
    // The runtime stays separate — the plugin is a client of `prx mcp serve`.
    expect(mcp.mcpServers.prx).toEqual({ command: "prx", args: ["mcp", "serve"] });
  });

  test("emits one slash command per verb, delegating to the verb's MCP tool", () => {
    const files = toClaudePlugin(reg);

    const pilotCmd = find(files, "commands/prx-pilot.md")!;
    expect(pilotCmd.content).toContain("allowed-tools: mcp__prx__pilot");
    expect(pilotCmd.content).toContain("argument-hint: <workUnitId>");
    expect(pilotCmd.content).toContain("$ARGUMENTS");

    // Namespaced ids: spaces → dashes in the filename, underscores in the tool.
    const planCmd = find(files, "commands/prx-plan-session.md")!;
    expect(planCmd.content).toContain("mcp__prx__plan_session");
    expect(mcpToolRef("prx", reg["plan session"]!)).toBe("mcp__prx__plan_session");
  });

  test("the command set covers exactly the registry", () => {
    const files = toClaudePlugin(reg);
    const commands = files.filter((f) => f.path.startsWith("commands/")).map((f) => f.path).sort();
    expect(commands).toEqual([
      "commands/prx-fleet.md",
      "commands/prx-pilot.md",
      "commands/prx-plan-session.md",
    ]);
  });

  test("opts customize runtime command + plugin name", () => {
    const files = toClaudePlugin(reg, { name: "prx-dev", mcpCommand: "/usr/local/bin/prx", mcpArgs: ["mcp"] });
    const mcp = JSON.parse(find(files, ".mcp.json")!.content);
    expect(mcp.mcpServers["prx-dev"]).toEqual({ command: "/usr/local/bin/prx", args: ["mcp"] });
    expect(find(files, "commands/prx-pilot.md")!.content).toContain("mcp__prx-dev__pilot");
  });
});
