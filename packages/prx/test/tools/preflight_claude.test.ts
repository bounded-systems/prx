import { describe, expect, test } from "bun:test";
import {
  REQUIRED_BINARIES,
  formatClaudePreflight,
  runClaudePreflight,
  type ClaudePreflightResult,
  type PreflightExec,
} from "../../src/tools/preflight_claude.ts";

describe("formatClaudePreflight", () => {
  test("plain format reports OK with resolved paths", () => {
    const result: ClaudePreflightResult = {
      ok: true,
      missing: [],
      resolved: {
        "typescript-language-server": "/opt/bin/typescript-language-server",
        tsserver: "/opt/bin/tsserver",
      },
    };
    const out = formatClaudePreflight(result, "plain");
    expect(out).toContain("claude preflight: OK");
    for (const bin of REQUIRED_BINARIES) {
      expect(out).toContain(bin);
      expect(out).toContain(result.resolved[bin]!);
    }
  });

  test("plain format reports missing binaries and install hint", () => {
    const result: ClaudePreflightResult = {
      ok: false,
      missing: ["typescript-language-server"],
      resolved: { tsserver: "/opt/bin/tsserver" },
    };
    const out = formatClaudePreflight(result, "plain");
    expect(out).toContain("missing required binaries");
    expect(out).toContain("typescript-language-server");
    expect(out).toContain("programs.claude-runtime.enable = true");
  });

  test("json format round-trips the result", () => {
    const result: ClaudePreflightResult = {
      ok: false,
      missing: ["tsserver"],
      resolved: {},
    };
    const out = formatClaudePreflight(result, "json");
    expect(JSON.parse(out)).toEqual(result);
  });
});

describe("runClaudePreflight", () => {
  test("ok=true with resolved paths when every binary is on PATH", async () => {
    const exec: PreflightExec = async ({ args }) => ({
      status: 0,
      stdout: `/opt/bin/${args[1]!.replace("command -v ", "")}\n`,
    });
    const r = await runClaudePreflight(exec);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
    expect(Object.keys(r.resolved).sort()).toEqual([...REQUIRED_BINARIES].sort());
  });

  test("missing when command -v exits non-zero", async () => {
    const r = await runClaudePreflight(async () => ({ status: 1, stdout: "" }));
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual([...REQUIRED_BINARIES]);
  });

  test("missing when command -v succeeds but prints nothing", async () => {
    const r = await runClaudePreflight(async () => ({ status: 0, stdout: "   \n" }));
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual([...REQUIRED_BINARIES]);
  });

  test("the default exec resolves against the real PATH without throwing", async () => {
    // No injected exec → exercises defaultExec (the real /bin/sh command -v).
    const r = await runClaudePreflight();
    expect(typeof r.ok).toBe("boolean");
    expect(Array.isArray(r.missing)).toBe(true);
  });
});
