import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

import {
  buildClaudeSettings,
  claudeSettingsJson,
} from "../../src/init/claude_settings.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const checkedInPath = resolve(repoRoot, ".claude", "settings.json");

describe("buildClaudeSettings", () => {
  test("matches the checked-in <repo>/.claude/settings.json (drift sentinel)", () => {
    const onDisk = JSON.parse(readFileSync(checkedInPath, "utf8"));
    expect(buildClaudeSettings()).toEqual(onDisk);
  });

  test("serializer round-trips into the same object", () => {
    expect(JSON.parse(claudeSettingsJson())).toEqual(buildClaudeSettings());
  });

  test("ends with a trailing newline", () => {
    expect(claudeSettingsJson().endsWith("\n")).toBe(true);
  });

  test("denies destructive shell flags", () => {
    const settings = buildClaudeSettings();
    expect(settings.permissions.deny).toContain("Bash(rm -rf:*)");
    expect(settings.permissions.deny).toContain("Bash(git push --force:*)");
    expect(settings.permissions.deny).toContain("Bash(git push --force-with-lease:*)");
    expect(settings.permissions.deny).toContain("Bash(git reset --hard:*)");
  });
});
