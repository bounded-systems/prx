/**
 * SPIKE — project the verb registry to a Claude Code PLUGIN.
 *
 * "prx as an extension installed in Claude" is just one more projection of the
 * canonical `VerbSpec` registry. The plugin is the thin Claude-facing surface;
 * the prx RUNTIME stays separate. The generated `.mcp.json` points Claude at
 * `prx mcp serve` (stdio), and one slash command per verb delegates to that
 * MCP tool. Install the plugin, keep running the prx binary — Claude calls in.
 *
 *   registry ──▶ .claude-plugin/plugin.json   (manifest)
 *            ──▶ .mcp.json                     (client → `prx mcp serve`)
 *            ──▶ commands/prx-<verb>.md        (one slash command per verb)
 *
 * The same `toMcpToolset` that serves the MCP tools is what the runtime exposes,
 * so the plugin's commands and the server's tools can't drift — they're the
 * same registry.
 */

import { pluginAllowedTools, type ActorPolicies } from "./permissions.ts";
import { verbToken, type Registry, type VerbSpec } from "./verbspec.ts";

export type PluginFile = { path: string; content: string };

export type ClaudePluginOpts = {
  /** Plugin + MCP server name. Default "prx". */
  name?: string;
  version?: string;
  /** The separate runtime the MCP server runs. Default `prx mcp serve` (stdio). */
  mcpCommand?: string;
  mcpArgs?: string[];
  /** Slash-command filename prefix. Default "prx". */
  commandPrefix?: string;
  /** Per-actor tool policy driving each command's `allowed-tools`. */
  policies?: ActorPolicies;
};

/** `mcp__<server>__<verbToken>` — how a slash command names the verb's tool. */
export const mcpToolRef = (serverName: string, v: VerbSpec): string =>
  `mcp__${serverName}__${verbToken(v.id)}`;

function renderCommand(v: VerbSpec, serverName: string, policies?: ActorPolicies): string {
  const tool = mcpToolRef(serverName, v);
  const hint = (v.positionals ?? []).map((p) => `<${p}>`).join(" ");
  // The verb's own MCP tool + the actor's allowed tools (capability projection).
  const allowed = pluginAllowedTools(v, tool, policies).join(", ");
  return [
    "---",
    `description: ${v.summary}`,
    `argument-hint: ${hint || "[args]"}`,
    `allowed-tools: ${allowed}`,
    "---",
    "",
    `Run the prx \`${v.id}\` verb (actor: **${v.actor}**) by calling the \`${tool}\``,
    "MCP tool with the arguments in `$ARGUMENTS`, then report the result.",
    "Do not perform the verb's effects yourself — the prx runtime owns them.",
    "",
    "$ARGUMENTS",
    "",
  ].join("\n");
}

/**
 * Project the registry to the file set of an installable Claude Code plugin.
 * Pure — returns an in-memory file list; a caller writes them to disk.
 */
export function toClaudePlugin(reg: Registry, opts: ClaudePluginOpts = {}): PluginFile[] {
  const name = opts.name ?? "prx";
  const prefix = opts.commandPrefix ?? "prx";
  const files: PluginFile[] = [];

  files.push({
    path: ".claude-plugin/plugin.json",
    content: JSON.stringify(
      {
        name,
        version: opts.version ?? "0.0.0-spike",
        description: "prx pipeline orchestrator — verbs projected from the canonical registry",
      },
      null,
      2,
    ),
  });

  // The runtime stays separate: the plugin is an MCP client of `prx mcp serve`.
  files.push({
    path: ".mcp.json",
    content: JSON.stringify(
      {
        mcpServers: {
          [name]: {
            command: opts.mcpCommand ?? "prx",
            args: opts.mcpArgs ?? ["mcp", "serve"],
          },
        },
      },
      null,
      2,
    ),
  });

  for (const v of Object.values(reg)) {
    const slug = `${prefix}-${v.id.split(" ").join("-")}`;
    files.push({ path: `commands/${slug}.md`, content: renderCommand(v, name, opts.policies) });
  }

  return files;
}
