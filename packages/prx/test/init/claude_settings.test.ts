import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

import {
  buildClaudeSettings,
  buildOrgHarnessSettings,
  claudeSettingsJson,
  orgHarnessSettingsJson,
} from "../../src/init/claude_settings.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const checkedInPath = resolve(repoRoot, ".claude", "settings.json");

describe("buildClaudeSettings", () => {
  // Drift sentinel: this repo's checked-in .claude/settings.json carries the
  // bounded-systems harness baseline (env + SessionStart context hook), so it
  // must match the harness builder, not the bare public scaffolder.
  test.skipIf(!existsSync(checkedInPath))("matches the checked-in <repo>/.claude/settings.json (drift sentinel)", () => {
    const onDisk = JSON.parse(readFileSync(checkedInPath, "utf8"));
    expect(buildOrgHarnessSettings()).toEqual(onDisk);
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

  // No-leak guard: the public scaffolder (`prx init`) must not carry the
  // org-internal SessionStart context hook nor the org env baseline — an
  // open-source consumer has no access to bounded-systems' `.github-private`.
  test("public scaffolder omits the org harness (no leak into prx init)", () => {
    const settings = buildClaudeSettings();
    expect(settings.env).toBeUndefined();
    expect(settings.hooks).toBeUndefined();
  });
});

describe("buildOrgHarnessSettings", () => {
  test("layers the org env baseline on the public permissions", () => {
    const settings = buildOrgHarnessSettings();
    expect(settings.permissions).toEqual(buildClaudeSettings().permissions);
    expect(settings.env).toEqual({
      CLAUDE_CODE_SUBAGENT_MODEL: "haiku",
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "75",
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    });
  });

  test("wires the SessionStart context-injection hook", () => {
    const sessionStart = buildOrgHarnessSettings().hooks?.SessionStart;
    expect(sessionStart).toEqual([
      {
        matcher: "",
        hooks: [{ type: "command", command: "bash .claude/inject-org-context.sh" }],
      },
    ]);
  });

  test("serializer round-trips into the same object with a trailing newline", () => {
    expect(JSON.parse(orgHarnessSettingsJson())).toEqual(buildOrgHarnessSettings());
    expect(orgHarnessSettingsJson().endsWith("\n")).toBe(true);
  });
});
