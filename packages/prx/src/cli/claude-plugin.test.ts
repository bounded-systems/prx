import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { defineVerb, type Registry } from "@bounded-systems/verbspec";
import { actorAgentFiles, commandSlashFiles, mcpToolRef, toClaudePlugin } from "./claude-plugin.ts";
import { fleetVerb, pilotVerb } from "./pilot-verbs.ts";
import { CommandSpec } from "./registry.ts";

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

  test("emits a monitor that streams the runtime audit log into the session", () => {
    const files = toClaudePlugin(reg);

    // The watcher script the monitor runs.
    const watch = find(files, "bin/prx-audit-watch.sh")!;
    expect(watch).toBeDefined();
    expect(watch.content).toContain("#!/usr/bin/env bash");
    // Follows the daily audit NDJSON and forwards leg + agent-lifecycle rows.
    expect(watch.content).toContain("prx/audit");
    expect(watch.content).toContain("tail -n0 -F");
    expect(watch.content).toMatch(/machine.*pilot|fleet|session-entry/);

    // The monitor manifest points at that script via the plugin-root var.
    const monitors = JSON.parse(find(files, "monitors/monitors.json")!.content);
    expect(Array.isArray(monitors)).toBe(true);
    expect(monitors[0].name).toBe("prx-pipeline");
    expect(monitors[0].command).toContain("${CLAUDE_PLUGIN_ROOT}/bin/prx-audit-watch.sh");
  });

  test("the monitor name tracks the plugin name", () => {
    const files = toClaudePlugin(reg, { name: "prx-dev" });
    const monitors = JSON.parse(find(files, "monitors/monitors.json")!.content);
    expect(monitors[0].name).toBe("prx-dev-pipeline");
  });

  test("commandSlashFiles projects the full registry to Bash-delegating commands", () => {
    const cmds = [
      CommandSpec.parse({
        name: "triage agent",
        description: "run the triage operator for mainx",
        domain: "work-units",
        actor: "triage",
      }),
      CommandSpec.parse({
        name: "secret thing",
        description: "internal helper not for end users",
        domain: "work-units",
        actor: "work",
        internal: true,
      }),
    ];
    const files = commandSlashFiles(cmds);
    const paths = files.map((f) => f.path);

    expect(paths).toContain("commands/prx-triage-agent.md");
    // internal commands are excluded from the slash surface
    expect(paths).not.toContain("commands/prx-secret-thing.md");

    const triage = files.find((f) => f.path === "commands/prx-triage-agent.md")!;
    // Bash-delegates to the installed binary (works without `prx mcp serve`),
    // scoped to exactly this verb.
    expect(triage.content).toContain("allowed-tools: Bash(prx triage agent:*)");
    expect(triage.content).toContain("prx triage agent $ARGUMENTS");
  });

  test("quotes descriptions so a colon can't break YAML frontmatter", () => {
    const cmds = [
      CommandSpec.parse({
        name: "upgrade",
        description: "self update: flake update then switch",
        domain: "work-units",
        actor: "work",
      }),
    ];
    const md = commandSlashFiles(cmds)[0]!.content;
    expect(md).toContain('description: "self update: flake update then switch"');
  });

  test("actorAgentFiles projects actors to subagents scoped to their verbs", () => {
    const files = actorAgentFiles([
      {
        name: "triage",
        summary: "classify and label the inbox",
        verbs: [{ name: "triage agent", description: "run the triage operator" }],
      },
      { name: "scratch", verbs: [] },
    ]);

    const triage = files.find((f) => f.path === "agents/triage.md")!;
    expect(triage.content).toContain("name: triage");
    expect(triage.content).toContain("tools: Bash, Read, Grep, Glob");
    expect(triage.content).toContain("prx triage agent");
    // plugin agents cannot set permissionMode (reference) — we never emit it.
    expect(triage.content).not.toContain("permissionMode");
    // an actor with no verbs still yields a valid agent file
    expect(files.some((f) => f.path === "agents/scratch.md")).toBe(true);
  });

  test("opts customize runtime command + plugin name", () => {
    const files = toClaudePlugin(reg, { name: "prx-dev", mcpCommand: "/usr/local/bin/prx", mcpArgs: ["mcp"] });
    const mcp = JSON.parse(find(files, ".mcp.json")!.content);
    expect(mcp.mcpServers["prx-dev"]).toEqual({ command: "/usr/local/bin/prx", args: ["mcp"] });
    expect(find(files, "commands/prx-pilot.md")!.content).toContain("mcp__prx-dev__pilot");
  });
});
