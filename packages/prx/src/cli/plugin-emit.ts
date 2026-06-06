/**
 * Bridge: `prx plugin emit <dir>` — write the Claude-plugin projection of the
 * registry to disk so it can be loaded with `claude --plugin-dir <dir>`.
 *
 * Pure projection (`toClaudePlugin`) + a thin disk writer. The runtime stays
 * separate: the emitted `.mcp.json` points Claude back at `prx mcp serve`, and
 * the emitted `monitors/` + `bin/` give the live audit feedback loop. Same
 * registry that backs the CLI, the MCP tools, and the OpenAPI surface.
 */

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  actorAgentFiles,
  commandSlashFiles,
  hooksFile,
  toClaudePlugin,
  type PluginFile,
} from "./claude-plugin.ts";
import { orchestratorRegistry } from "./pilot-verbs.ts";
import { commandsByActor, prxActorRegistry, prxCommandRegistry } from "./registry.data.ts";

function flagValue(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

const USAGE = "usage: prx plugin emit <dir> [--name <name>] [--version <version>]";

/**
 * `prx plugin <sub> …`. Only `emit` is defined today: it materializes the
 * plugin file set under `<dir>`, creating parent dirs and marking `bin/`
 * scripts executable so the monitor can run them.
 */
export async function runPluginVerb(
  args: readonly string[],
  output: { log: (line: string) => void; error: (line: string) => void },
): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== "emit") {
    output.error(`prx plugin: unknown subcommand ${sub ? `"${sub}"` : "(none)"} — expected "emit"`);
    output.error(USAGE);
    return 1;
  }

  const dir = rest.find((a) => !a.startsWith("--"));
  if (!dir) {
    output.error(USAGE);
    return 1;
  }

  const name = flagValue(rest, "--name");
  const version = flagValue(rest, "--version");

  // Scaffold only (manifest, monitor, watcher) — drop the `.mcp.json` client
  // config and the MCP-based verb commands. The MCP surface returns later via
  // the meta-prx-CLI actor (#189); until then the emitted plugin is fully
  // Bash-delegating so it loads with zero failed connections.
  const scaffold = toClaudePlugin(orchestratorRegistry, {
    ...(name !== undefined ? { name } : {}),
    ...(version !== undefined ? { version } : {}),
  }).filter((f) => f.path !== ".mcp.json" && !f.path.startsWith("commands/"));

  // Every verb as a Bash-delegating slash command against the installed binary:
  // the orchestrator verbs (pilot/fleet) plus the full command registry.
  const verbSlash = commandSlashFiles(
    Object.values(orchestratorRegistry).map((v) => ({
      name: v.id,
      actor: v.actor,
      description: v.summary,
    })),
  );
  // Default to the PROMOTED surface only. Command listings are always-on
  // context in every session (unlike MCP tools, slash commands don't defer), so
  // emitting all ~216 verbs is a needless per-session token tax — and every verb
  // stays reachable via `prx <verb>` directly. `--all` opts into the full set.
  const includeAll = rest.includes("--all");
  const registryCommands = includeAll
    ? prxCommandRegistry
    : prxCommandRegistry.filter((c) => (c.promoted_in ?? []).length > 0);
  const regSlash = commandSlashFiles(registryCommands);

  // The actor registry as plugin subagents (agents/<actor>.md) — each embodies
  // an actor's role and is scoped to driving its own verbs.
  const agents = actorAgentFiles(
    prxActorRegistry.map((a) => ({
      name: a.name,
      ...(a.summary !== undefined ? { summary: a.summary } : {}),
      verbs: commandsByActor(a.name)
        .filter((c) => !c.internal && c.deprecation === undefined)
        .map((c) => ({ name: c.name, description: c.description })),
    })),
  );

  // The capability PreToolUse hook — Claude Code lifecycle → prx policy guard.
  const byPath = new Map<string, PluginFile>();
  for (const f of [...scaffold, ...verbSlash, ...regSlash, ...agents, ...hooksFile()]) {
    if (!byPath.has(f.path)) byPath.set(f.path, f);
  }
  const files = [...byPath.values()];

  for (const file of files) {
    const dest = join(dir, file.path);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, file.content);
    // The monitor runs `bin/` scripts — they must be executable.
    if (file.path.startsWith("bin/")) await chmod(dest, 0o755);
  }

  output.log(
    JSON.stringify(
      { dir, files: files.length, paths: files.map((f) => f.path).sort() },
      null,
      2,
    ),
  );
  return 0;
}
