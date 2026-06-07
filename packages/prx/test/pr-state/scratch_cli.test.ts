// GH-2394: `prx scratch` CLI parsing — the bare, work-unit-UNBOUND
// least-privilege session verb. Asserts the parser routes the command, the
// `--unsafe` escape-hatch flag, `--dry-run`/`--check`/`--help`, and that it
// rejects positionals (scratch is unbound).

import { describe, expect, test } from "bun:test";

import { parseCommand } from "../../src/pr-state/cli.ts";
import { CliError } from "../../src/pr-state/cli-error.ts";
import { prxCommandRegistry } from "../../src/cli/registry.data.ts";

describe("prx scratch — CLI parsing (GH-2394)", () => {
  test("bare `prx scratch` routes to the scratch command, safe by default", () => {
    const parsed = parseCommand(["scratch"]);
    expect(parsed.command).toBe("scratch");
    if (parsed.command !== "scratch") throw new Error("unreachable");
    expect(parsed.unsafe).toBe(false);
    expect(parsed.dryRun).toBe(false);
    expect(parsed.check).toBe(false);
    expect(parsed.help).toBe(false);
  });

  test("`--unsafe` is the single escape-hatch flag", () => {
    const parsed = parseCommand(["scratch", "--unsafe"]);
    expect(parsed.command).toBe("scratch");
    if (parsed.command !== "scratch") throw new Error("unreachable");
    expect(parsed.unsafe).toBe(true);
  });

  test("`--dry-run` and `--check` parse independently", () => {
    const dry = parseCommand(["scratch", "--dry-run", "--format", "json"]);
    if (dry.command !== "scratch") throw new Error("unreachable");
    expect(dry.dryRun).toBe(true);
    expect(dry.format).toBe("json");

    const check = parseCommand(["scratch", "--check"]);
    if (check.command !== "scratch") throw new Error("unreachable");
    expect(check.check).toBe(true);
  });

  test("`--help` early-exits to the banner path (help flag set)", () => {
    for (const flag of ["--help", "-h"]) {
      const parsed = parseCommand(["scratch", flag]);
      expect(parsed.command).toBe("scratch");
      if (parsed.command !== "scratch") throw new Error("unreachable");
      expect(parsed.help).toBe(true);
    }
  });

  test("rejects positional arguments (scratch is work-unit-unbound)", () => {
    expect(() => parseCommand(["scratch", "GH-2394"])).toThrow(CliError);
  });

  test("registry advertises a bare `scratch` entry bound to the scratch profile", () => {
    const entry = prxCommandRegistry.find((c) => c.name === "scratch");
    expect(entry).toBeDefined();
    expect(entry?.session_profile).toBe("scratch");
    expect(entry?.binding).toBe("mainx");
    expect(entry?.actor).toBe("scratch");
    // Bare command — no parent namespace.
    expect(entry?.parent).toBeUndefined();
    // Not promoted in any context (canonical-catalog only, per help-surface.md).
    expect(entry?.promoted_in ?? []).toEqual([]);
  });
});
