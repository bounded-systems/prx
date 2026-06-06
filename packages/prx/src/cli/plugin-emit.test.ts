import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runPluginVerb } from "./plugin-emit.ts";

function sink() {
  const lines: string[] = [];
  const errs: string[] = [];
  return {
    out: { log: (l: string) => lines.push(l), error: (e: string) => errs.push(e) },
    lines,
    errs,
  };
}

describe("prx plugin emit", () => {
  test("materializes the plugin projection to disk (manifest, mcp, monitor, watcher)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prx-plugin-"));
    const { out, lines } = sink();

    const code = await runPluginVerb(["emit", dir], out);
    expect(code).toBe(0);

    const manifest = JSON.parse(await readFile(join(dir, ".claude-plugin/plugin.json"), "utf8"));
    expect(manifest.name).toBe("prx");

    // No MCP client config: the emitted plugin is fully Bash-delegating, so it
    // loads with no failed MCP connection. (The MCP surface returns later via
    // the meta-prx-CLI actor, #189.)
    let mcpExists = true;
    try {
      await stat(join(dir, ".mcp.json"));
    } catch {
      mcpExists = false;
    }
    expect(mcpExists).toBe(false);

    // pilot/fleet are Bash-delegating too, not MCP tools.
    const pilot = await readFile(join(dir, "commands/prx-pilot.md"), "utf8");
    expect(pilot).toContain("allowed-tools: Bash(prx pilot:*)");
    expect(pilot).toContain("prx pilot $ARGUMENTS");

    const monitors = JSON.parse(await readFile(join(dir, "monitors/monitors.json"), "utf8"));
    expect(monitors[0].name).toBe("prx-pipeline");

    // The capability PreToolUse hook → prx policy guard, routed through the
    // bundled resolver script (not a bare `prx`) so it survives a minimal-PATH
    // launch context.
    const hooks = JSON.parse(await readFile(join(dir, "hooks/hooks.json"), "utf8"));
    expect(hooks.hooks.PreToolUse[0].matcher).toBe("Bash");
    expect(hooks.hooks.PreToolUse[0].hooks[0].command).toBe(
      'bash "${CLAUDE_PLUGIN_ROOT}/bin/prx-policy-guard.sh"',
    );

    // The resolver script is on disk, executable, and resolves prx by PATH then
    // common install dirs before delegating to `prx hook policy-guard`.
    const guard = join(dir, "bin/prx-policy-guard.sh");
    const guardSrc = await readFile(guard, "utf8");
    expect(guardSrc).toContain("command -v prx");
    expect(guardSrc).toContain("hook policy-guard");
    expect((await stat(guard)).mode & 0o111).not.toBe(0);

    // The watcher script is on disk and executable (the monitor runs it).
    const watch = join(dir, "bin/prx-audit-watch.sh");
    expect((await readFile(watch, "utf8"))).toContain("tail -n0 -F");
    expect((await stat(watch)).mode & 0o111).not.toBe(0);

    // Reports a JSON summary of what was written.
    const summary = JSON.parse(lines.join("\n"));
    expect(summary.dir).toBe(dir);
    expect(summary.paths).toContain("monitors/monitors.json");
  });

  test("emits the promoted surface by default, full surface with --all", async () => {
    const exists = async (p: string) => {
      try {
        await stat(p);
        return true;
      } catch {
        return false;
      }
    };

    const lean = await mkdtemp(join(tmpdir(), "prx-plugin-"));
    await runPluginVerb(["emit", lean], sink().out);
    // pilot/fleet + promoted verbs present …
    expect(await exists(join(lean, "commands/prx-pilot.md"))).toBe(true);
    expect(await exists(join(lean, "commands/prx-next.md"))).toBe(true);
    // … but a non-promoted verb is omitted by default (it's still `prx upgrade`).
    expect(await exists(join(lean, "commands/prx-upgrade.md"))).toBe(false);

    const full = await mkdtemp(join(tmpdir(), "prx-plugin-"));
    await runPluginVerb(["emit", full, "--all"], sink().out);
    expect(await exists(join(full, "commands/prx-upgrade.md"))).toBe(true);
  });

  test("honors --name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prx-plugin-"));
    const { out } = sink();
    await runPluginVerb(["emit", dir, "--name", "prx-dev"], out);
    const manifest = JSON.parse(await readFile(join(dir, ".claude-plugin/plugin.json"), "utf8"));
    expect(manifest.name).toBe("prx-dev");
  });

  test("rejects a missing dir and an unknown subcommand", async () => {
    const a = sink();
    expect(await runPluginVerb(["emit"], a.out)).toBe(1);
    expect(a.errs.join("\n")).toContain("usage:");

    const b = sink();
    expect(await runPluginVerb(["bogus"], b.out)).toBe(1);
    expect(b.errs.join("\n")).toContain("emit");
  });
});
