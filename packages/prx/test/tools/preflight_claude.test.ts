import { describe, expect, test } from "bun:test";
import {
  REQUIRED_BINARIES,
  formatClaudePreflight,
  type ClaudePreflightResult,
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
