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

    const mcp = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.prx).toEqual({ command: "prx", args: ["mcp", "serve"] });

    const monitors = JSON.parse(await readFile(join(dir, "monitors/monitors.json"), "utf8"));
    expect(monitors[0].name).toBe("prx-pipeline");

    // The watcher script is on disk and executable (the monitor runs it).
    const watch = join(dir, "bin/prx-audit-watch.sh");
    expect((await readFile(watch, "utf8"))).toContain("tail -n0 -F");
    expect((await stat(watch)).mode & 0o111).not.toBe(0);

    // Reports a JSON summary of what was written.
    const summary = JSON.parse(lines.join("\n"));
    expect(summary.dir).toBe(dir);
    expect(summary.paths).toContain("monitors/monitors.json");
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
