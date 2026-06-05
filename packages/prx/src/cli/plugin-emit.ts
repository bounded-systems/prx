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

import { commandSlashFiles, toClaudePlugin, type PluginFile } from "./claude-plugin.ts";
import { orchestratorRegistry } from "./pilot-verbs.ts";
import { prxCommandRegistry } from "./registry.data.ts";

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

  // Scaffold + the spec-driven orchestrator verbs (pilot/fleet, via MCP) …
  const base = toClaudePlugin(orchestratorRegistry, {
    ...(name !== undefined ? { name } : {}),
    ...(version !== undefined ? { version } : {}),
  });
  // … plus the *full* registry as Bash-delegating slash commands (work today
  // against the installed binary, no `prx mcp serve` required). Merge and
  // dedupe by path — the spec-driven commands win on any name collision.
  const slash = commandSlashFiles(prxCommandRegistry);
  const byPath = new Map<string, PluginFile>();
  for (const f of [...base, ...slash]) if (!byPath.has(f.path)) byPath.set(f.path, f);
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
