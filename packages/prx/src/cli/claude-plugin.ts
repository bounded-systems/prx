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
 *            ──▶ monitors/monitors.json        (live audit-log feed → in-session)
 *            ──▶ bin/prx-audit-watch.sh        (the monitor's stream command)
 *
 * The monitor closes the feedback loop: a running `prx pilot`/`fleet` streams
 * its leg + agent events into the Claude session, so the pipeline is visible
 * live instead of being a silent subprocess.
 *
 * The same `toMcpToolset` that serves the MCP tools is what the runtime exposes,
 * so the plugin's commands and the server's tools can't drift — they're the
 * same registry.
 */

import { pluginAllowedTools, type ActorPolicies } from "./permissions.ts";
import { verbToken, type Registry, type VerbSpec } from "./verbspec.ts";

export type PluginFile = { path: string; content: string };

/**
 * The minimal shape {@link commandSlashFiles} needs to render a Bash-delegating
 * slash command. `CommandSpec` (the full registry) and a mapped `VerbSpec`
 * (pilot/fleet) both satisfy it structurally.
 */
export type SlashSource = {
  name: string;
  actor: string;
  description: string;
  internal?: boolean;
  deprecation?: unknown;
};

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
  /** Manifest author. Default `{ name: "bounded-systems" }`. */
  author?: { name: string; email?: string; url?: string };
};

/** `mcp__<server>__<verbToken>` — how a slash command names the verb's tool. */
export const mcpToolRef = (serverName: string, v: VerbSpec): string =>
  `mcp__${serverName}__${verbToken(v.id)}`;

// ── Frontmatter serialization ────────────────────────────────────────────────
// Render markdown docs from a TYPED field map instead of hand-built strings, so
// a `:` / `#` / quote in any value can never break the YAML frontmatter — the
// exact class of bug `claude plugin validate` caught in `prx-upgrade.md`. A value
// is quoted only when a YAML plain scalar would misparse it; otherwise left bare.

/** Serialize one frontmatter value as a YAML-safe scalar. */
function yamlScalar(v: string): string {
  const needsQuote =
    v === "" ||
    /:\s/.test(v) || // ": " starts a mapping
    /\s#/.test(v) || // " #" starts a comment
    /^\s|\s$/.test(v) || // leading/trailing space
    /^[!&*?|>@`"'%,#[\]{}-]/.test(v) || // leading YAML indicator
    /[\n"\\]/.test(v);
  // JSON.stringify yields a valid YAML double-quoted scalar for any string.
  return needsQuote ? JSON.stringify(v) : v;
}

/** A markdown doc: YAML frontmatter from a typed field map, then the body. */
function markdownDoc(frontmatter: Record<string, string>, body: string[]): string {
  const fm = Object.entries(frontmatter).map(([k, v]) => `${k}: ${yamlScalar(v)}`);
  return ["---", ...fm, "---", "", ...body, ""].join("\n");
}

function renderCommand(v: VerbSpec, serverName: string, policies?: ActorPolicies): string {
  const tool = mcpToolRef(serverName, v);
  const hint = (v.positionals ?? []).map((p) => `<${p}>`).join(" ");
  // The verb's own MCP tool + the actor's allowed tools (capability projection).
  const allowed = pluginAllowedTools(v, tool, policies).join(", ");
  return markdownDoc(
    {
      description: v.summary,
      "argument-hint": hint || "[args]",
      "allowed-tools": allowed,
    },
    [
      `Run the prx \`${v.id}\` verb (actor: **${v.actor}**) by calling the \`${tool}\``,
      "MCP tool with the arguments in `$ARGUMENTS`, then report the result.",
      "Do not perform the verb's effects yourself — the prx runtime owns them.",
      "",
      "$ARGUMENTS",
    ],
  );
}

/**
 * The monitor's stream command. Tails the runtime's daily audit NDJSON and
 * forwards only high-signal rows — pilot/fleet/session-entry machine
 * transitions and the non-interactive agent lifecycle — so a running
 * `prx pilot` is visible in-session. Each forwarded line is one notification.
 */
const AUDIT_WATCH_SCRIPT = `#!/usr/bin/env bash
# prx plugin monitor — stream pilot/fleet pipeline events into the Claude session.
# The runtime appends one NDJSON line per event to
#   \${XDG_STATE_HOME:-$HOME/.local/state}/prx/audit/<YYYY-MM-DD>.ndjson
# Follow today's file (-F retries until it is created on the first event) and
# forward only leg transitions + agent start/finish.
set -uo pipefail
dir="\${XDG_STATE_HOME:-$HOME/.local/state}/prx/audit"
file="$dir/$(date +%F).ndjson"
tail -n0 -F "$file" 2>/dev/null \\
  | grep --line-buffered -E '"machine":"(pilot|fleet|session-entry)"|"kind":"non-interactive-agent"'
`;

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
        author: opts.author ?? { name: "bounded-systems" },
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

  // Observability: a background monitor streams the runtime audit log into the
  // session, so a running `prx pilot`/`fleet` shows up live instead of being a
  // silent subprocess. The watcher script is the monitor's stream command;
  // `${CLAUDE_PLUGIN_ROOT}` resolves to the plugin's install dir at runtime.
  files.push({ path: "bin/prx-audit-watch.sh", content: AUDIT_WATCH_SCRIPT });
  files.push({
    path: "monitors/monitors.json",
    content: JSON.stringify(
      [
        {
          name: `${name}-pipeline`,
          command: `bash "\${CLAUDE_PLUGIN_ROOT}/bin/prx-audit-watch.sh"`,
          description:
            "Live prx pipeline events — pilot/fleet leg transitions and agent " +
            "start/finish, streamed from the runtime audit log.",
        },
      ],
      null,
      2,
    ),
  });

  return files;
}

/** A slash command that runs a full-registry verb through the installed binary. */
function renderBashCommand(c: SlashSource): string {
  return markdownDoc(
    {
      description: c.description,
      "argument-hint": "[args]",
      // Capability projection: scope the slash command to exactly this verb.
      "allowed-tools": `Bash(prx ${c.name}:*)`,
    },
    [
      `Run the prx \`${c.name}\` command (actor: **${c.actor}**) by executing`,
      `\`prx ${c.name} $ARGUMENTS\` with the Bash tool, then report the result.`,
      "Do not perform the command's effects yourself — the prx runtime owns them.",
      "",
      "$ARGUMENTS",
    ],
  );
}

/**
 * Project the full prx command registry to Bash-delegating slash commands —
 * one `/<prefix>:<verb>` per non-internal, non-deprecated command, each running
 * the verb through the installed `prx` binary.
 *
 * Unlike the VerbSpec→MCP commands {@link toClaudePlugin} emits, these need no
 * `prx mcp serve`: they work against the runtime today. Pure — the caller
 * passes the registry (e.g. `prxCommandRegistry`) so this stays data-free.
 */
export function commandSlashFiles(commands: SlashSource[], prefix = "prx"): PluginFile[] {
  return commands
    .filter((c) => !c.internal && c.deprecation === undefined)
    .map((c) => ({
      path: `commands/${prefix}-${c.name.split(" ").join("-")}.md`,
      content: renderBashCommand(c),
    }));
}

/** An actor and the verbs it owns — the source for a plugin subagent. */
export type ActorAgentSource = {
  name: string;
  summary?: string;
  verbs: { name: string; description: string }[];
};

/** A plugin subagent (`agents/<actor>.md`) embodying one prx actor's role. */
function renderAgent(a: ActorAgentSource): string {
  const role = a.summary ?? `the prx ${a.name} actor`;
  const verbLines = a.verbs.map((v) => `- \`prx ${v.name}\` — ${v.description}`);
  // `description` drives when Claude delegates to this subagent.
  const description = `${a.summary ? `${a.summary}. ` : ""}The prx \`${a.name}\` actor — delegate ${a.name}-domain work to this subagent.`;
  return markdownDoc(
    {
      name: a.name,
      // plugin agents may NOT set permissionMode/hooks/mcpServers (reference).
      description,
      tools: "Bash, Read, Grep, Glob",
    },
    [
      `You are the **prx \`${a.name}\`** actor — ${role}.`,
      "",
      ...(verbLines.length
        ? ["You carry out your role through these prx verbs:", "", ...verbLines, ""]
        : []),
      "Run them with the Bash tool (`prx <verb> …`) and report a concise result.",
      "Don't perform effects outside your verbs — the prx runtime owns them.",
    ],
  );
}

/**
 * Project the prx actor registry to plugin subagents — one `agents/<actor>.md`
 * per actor, each embodying that actor's role and scoped to driving its verbs.
 * Pure — the caller resolves each actor's verbs (e.g. via `commandsByActor`).
 */
export function actorAgentFiles(actors: ActorAgentSource[]): PluginFile[] {
  return actors.map((a) => ({ path: `agents/${a.name}.md`, content: renderAgent(a) }));
}

/**
 * Project the capability `PreToolUse` hook — the Claude Code lifecycle → prx
 * policy bridge. When a Bash tool call fires inside a prx actor-subagent, Claude
 * Code routes it through `prx hook policy-guard`, which denies anything that
 * actor doesn't own (plus universal hard-blocks for every session). The plugin
 * is thin: the prx runtime owns the policy.
 */
export function hooksFile(): PluginFile {
  return {
    path: "hooks/hooks.json",
    content: JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "prx hook policy-guard" }],
            },
          ],
        },
      },
      null,
      2,
    ),
  };
}
