/**
 * prx-5el — the SDK's native CLI can't self-resolve from a bun-compiled binary,
 * so we set `pathToClaudeCodeExecutable` to an installed `claude`. The release
 * binary bakes the CI runner's `$HOME/.local/bin/claude` (truthy but absent on
 * the operator's machine); the resolver must skip a dead candidate and fall
 * through to one that EXISTS, or the SDK throws "Native CLI binary … not found".
 */
import { describe, expect, test } from "bun:test";

import { resolveClaudeExecutablePath } from "../../src/claude/agent_service.ts";

describe("resolveClaudeExecutablePath (prx-5el)", () => {
  test("skips a dead baked path and falls through to one that exists", () => {
    const real = "/Users/bobby/.local/bin/claude";
    const got = resolveClaudeExecutablePath(
      [undefined, "/Users/runner/.local/bin/claude", real], // baked CI path is dead
      (p) => p === real,
    );
    expect(got).toBe(real);
  });

  test("prefers the first candidate that exists (PRX_CLAUDE_CODE_PATH is tier-1)", () => {
    expect(resolveClaudeExecutablePath(["/opt/claude", "/baked/claude"], () => true)).toBe(
      "/opt/claude",
    );
  });

  test("returns undefined when no candidate exists (dev/CI: SDK self-resolves)", () => {
    expect(resolveClaudeExecutablePath(["/a", "/b"], () => false)).toBeUndefined();
  });

  test("ignores empty/undefined candidates", () => {
    expect(resolveClaudeExecutablePath([undefined, "", "/real"], (p) => p === "/real")).toBe(
      "/real",
    );
  });
});
