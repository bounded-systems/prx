import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  CLAUDE_LOCAL_SETTINGS_RELATIVE_PATH,
  PRX_BASH_ALLOW_PATTERN,
  WORKTREE_CREATE_HOOK_COMMAND,
  WORKTREE_REMOVE_HOOK_COMMAND,
  ensureClaudeInteractiveAllowlist,
  ensureClaudeSessionProfileAllowlist,
  ensureClaudeWorktreeHooks,
  sessionProfileBashAllowPatterns,
} from "../../src/machine/claude_local_settings.ts";
import { SESSION_PROFILES } from "../../src/machine/runtime_profiles.ts";

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "claude-local-settings-"));
}

function readSettings(cwd: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(cwd, CLAUDE_LOCAL_SETTINGS_RELATIVE_PATH), "utf8"));
}

describe("ensureClaudeInteractiveAllowlist", () => {
  test("creates .claude/settings.local.json with Bash(prx:*) when missing", () => {
    const cwd = mkTmp();
    const result = ensureClaudeInteractiveAllowlist(cwd);

    expect(result.status).toBe("created");
    expect(existsSync(result.path)).toBe(true);
    const settings = readSettings(cwd);
    expect(settings).toEqual({
      permissions: { allow: [PRX_BASH_ALLOW_PATTERN] },
    });
  });

  test("merges Bash(prx:*) into existing allow list while preserving other entries", () => {
    const cwd = mkTmp();
    mkdirSync(join(cwd, ".claude"));
    writeFileSync(
      join(cwd, CLAUDE_LOCAL_SETTINGS_RELATIVE_PATH),
      JSON.stringify({
        permissions: { allow: ["Read(/tmp/**)", "Bash(git status:*)"] },
        prefersReducedMotion: true,
      }),
    );

    const result = ensureClaudeInteractiveAllowlist(cwd);

    expect(result.status).toBe("updated");
    const settings = readSettings(cwd);
    expect(settings.prefersReducedMotion).toBe(true);
    const permissions = settings.permissions as { allow: string[] };
    expect(permissions.allow).toEqual([
      "Read(/tmp/**)",
      "Bash(git status:*)",
      PRX_BASH_ALLOW_PATTERN,
    ]);
  });

  test("preserves non-string entries in existing allow list on merge", () => {
    const cwd = mkTmp();
    mkdirSync(join(cwd, ".claude"));
    const exotic = { type: "Bash", pattern: "Bash(git status:*)" };
    writeFileSync(
      join(cwd, CLAUDE_LOCAL_SETTINGS_RELATIVE_PATH),
      JSON.stringify({ permissions: { allow: [exotic, "Read(/tmp/**)"] } }),
    );

    const result = ensureClaudeInteractiveAllowlist(cwd);

    expect(result.status).toBe("updated");
    const settings = readSettings(cwd);
    const permissions = settings.permissions as { allow: unknown[] };
    expect(permissions.allow).toEqual([exotic, "Read(/tmp/**)", PRX_BASH_ALLOW_PATTERN]);
  });

  test("is idempotent — second call reports unchanged", () => {
    const cwd = mkTmp();
    expect(ensureClaudeInteractiveAllowlist(cwd).status).toBe("created");
    const before = readFileSync(join(cwd, CLAUDE_LOCAL_SETTINGS_RELATIVE_PATH), "utf8");
    const second = ensureClaudeInteractiveAllowlist(cwd);
    expect(second.status).toBe("unchanged");
    const after = readFileSync(join(cwd, CLAUDE_LOCAL_SETTINGS_RELATIVE_PATH), "utf8");
    expect(after).toBe(before);
  });

  test("refuses to stomp on a malformed settings file", () => {
    const cwd = mkTmp();
    mkdirSync(join(cwd, ".claude"));
    writeFileSync(join(cwd, CLAUDE_LOCAL_SETTINGS_RELATIVE_PATH), "{ not: valid json");
    const result = ensureClaudeInteractiveAllowlist(cwd);
    expect(result.status).toBe("skipped-malformed");
    const raw = readFileSync(join(cwd, CLAUDE_LOCAL_SETTINGS_RELATIVE_PATH), "utf8");
    expect(raw).toBe("{ not: valid json");
  });

  test("treats a top-level JSON array as malformed (not a settings object)", () => {
    const cwd = mkTmp();
    mkdirSync(join(cwd, ".claude"));
    writeFileSync(join(cwd, CLAUDE_LOCAL_SETTINGS_RELATIVE_PATH), "[]");
    expect(ensureClaudeInteractiveAllowlist(cwd).status).toBe("skipped-malformed");
  });

  test("creates a fresh allow list when permissions exists without one", () => {
    const cwd = mkTmp();
    mkdirSync(join(cwd, ".claude"));
    writeFileSync(
      join(cwd, CLAUDE_LOCAL_SETTINGS_RELATIVE_PATH),
      JSON.stringify({ permissions: { deny: ["Bash(rm -rf /*)"] } }),
    );
    const result = ensureClaudeInteractiveAllowlist(cwd);
    expect(result.status).toBe("updated");
    const settings = readSettings(cwd);
    const permissions = settings.permissions as { allow: string[]; deny: string[] };
    expect(permissions.allow).toEqual([PRX_BASH_ALLOW_PATTERN]);
    expect(permissions.deny).toEqual(["Bash(rm -rf /*)"]);
  });
});

describe("sessionProfileBashAllowPatterns (GH-1545)", () => {
  test("intake projects exactly the Bash(…) subset of SESSION_PROFILES.intake.allowedTools", () => {
    expect(sessionProfileBashAllowPatterns("intake")).toEqual(["Bash(prx intake:*)"]);
  });

  test("triage projects exactly the Bash(…) subset of SESSION_PROFILES.triage.allowedTools", () => {
    expect(sessionProfileBashAllowPatterns("triage")).toEqual([
      // GH-1530: classify/apply collapsed onto the registry-derived
      // own-namespace glob (which also covers `prx triage dispatch …`).
      "Bash(prx triage:*)",
      // GH-1530 PR-6: the dedupe-search read migrated to dispatch
      // (prx triage dispatch --actor=intake -- search) — no direct grant.
      // prx-arl: `prx tools labels sync` retired (dead operator surface).
      "Bash(bd create:*)",
      "Bash(bd update:*)",
      "Bash(bd dep:*)",
      "Bash(gh issue comment:*)",
      "Bash(gh issue edit:*)",
    ]);
  });

  // Drift guard: the projection is just the `Bash(…)` filter over the profile
  // allowlist — keep it derived, not hand-maintained, so a profile change
  // flows through automatically.
  test("derived patterns stay the Bash(…) filter over each profile's allowedTools", () => {
    for (const name of ["plan", "intake", "triage", "implement", "submit", "author"] as const) {
      expect(sessionProfileBashAllowPatterns(name)).toEqual(
        SESSION_PROFILES[name].allowedTools.filter((tool) => tool.startsWith("Bash(")),
      );
    }
  });

  test("drops bare tool names (Read/Grep/Glob) — they aren't permission-prompt patterns", () => {
    expect(sessionProfileBashAllowPatterns("intake")).not.toContain("Read");
    expect(sessionProfileBashAllowPatterns("intake")).not.toContain("Grep");
    expect(sessionProfileBashAllowPatterns("intake")).not.toContain("Glob");
  });
});

describe("ensureClaudeSessionProfileAllowlist (GH-1545)", () => {
  test("creates .claude/settings.local.json with the intake profile's Bash(…) verbs", () => {
    const cwd = mkTmp();
    const result = ensureClaudeSessionProfileAllowlist(cwd, "intake");

    expect(result.status).toBe("created");
    expect(existsSync(result.path)).toBe(true);
    const settings = readSettings(cwd);
    expect(settings).toEqual({
      permissions: { allow: ["Bash(prx intake:*)"] },
    });
  });

  test("creates the full triage Bash(…) set for the triage profile", () => {
    const cwd = mkTmp();
    const result = ensureClaudeSessionProfileAllowlist(cwd, "triage");

    expect(result.status).toBe("created");
    const settings = readSettings(cwd);
    const permissions = settings.permissions as { allow: string[] };
    expect(permissions.allow).toEqual(sessionProfileBashAllowPatterns("triage"));
  });

  test("is idempotent — second call reports unchanged", () => {
    const cwd = mkTmp();
    expect(ensureClaudeSessionProfileAllowlist(cwd, "intake").status).toBe("created");
    const before = readFileSync(join(cwd, CLAUDE_LOCAL_SETTINGS_RELATIVE_PATH), "utf8");
    expect(ensureClaudeSessionProfileAllowlist(cwd, "intake").status).toBe("unchanged");
    const after = readFileSync(join(cwd, CLAUDE_LOCAL_SETTINGS_RELATIVE_PATH), "utf8");
    expect(after).toBe(before);
  });

  test("merges the profile verbs into an existing allow list, keeping unrelated entries", () => {
    const cwd = mkTmp();
    mkdirSync(join(cwd, ".claude"));
    writeFileSync(
      join(cwd, CLAUDE_LOCAL_SETTINGS_RELATIVE_PATH),
      JSON.stringify({
        permissions: { allow: [PRX_BASH_ALLOW_PATTERN, "Read(/tmp/**)"] },
        prefersReducedMotion: true,
      }),
    );

    const result = ensureClaudeSessionProfileAllowlist(cwd, "triage");

    expect(result.status).toBe("updated");
    const settings = readSettings(cwd);
    expect(settings.prefersReducedMotion).toBe(true);
    const permissions = settings.permissions as { allow: string[] };
    expect(permissions.allow).toEqual([
      PRX_BASH_ALLOW_PATTERN,
      "Read(/tmp/**)",
      ...sessionProfileBashAllowPatterns("triage"),
    ]);
  });

  test("only appends the patterns not already present", () => {
    const cwd = mkTmp();
    mkdirSync(join(cwd, ".claude"));
    writeFileSync(
      join(cwd, CLAUDE_LOCAL_SETTINGS_RELATIVE_PATH),
      JSON.stringify({ permissions: { allow: ["Bash(prx triage:*)"] } }),
    );

    const result = ensureClaudeSessionProfileAllowlist(cwd, "triage");

    expect(result.status).toBe("updated");
    const permissions = (readSettings(cwd).permissions as { allow: string[] });
    expect(permissions.allow).toEqual([
      // GH-1530: the own-namespace glob is already present; only the remaining
      // patterns are appended, in profile order. GH-1530 PR-6: intake search
      // migrated to dispatch, so it is no longer in the projected subset.
      "Bash(prx triage:*)",
      "Bash(bd create:*)",
      "Bash(bd update:*)",
      "Bash(bd dep:*)",
      "Bash(gh issue comment:*)",
      "Bash(gh issue edit:*)",
    ]);
  });

  test("refuses to stomp on a malformed settings file", () => {
    const cwd = mkTmp();
    mkdirSync(join(cwd, ".claude"));
    writeFileSync(join(cwd, CLAUDE_LOCAL_SETTINGS_RELATIVE_PATH), "{ not: valid json");
    const result = ensureClaudeSessionProfileAllowlist(cwd, "intake");
    expect(result.status).toBe("skipped-malformed");
    expect(readFileSync(join(cwd, CLAUDE_LOCAL_SETTINGS_RELATIVE_PATH), "utf8")).toBe(
      "{ not: valid json",
    );
  });
});

describe("ensureClaudeWorktreeHooks (prx-5q3)", () => {
  const expectedHooks = {
    WorktreeCreate: [{ hooks: [{ type: "command", command: WORKTREE_CREATE_HOOK_COMMAND }] }],
    WorktreeRemove: [{ hooks: [{ type: "command", command: WORKTREE_REMOVE_HOOK_COMMAND }] }],
  };

  test("creates settings.local.json with the WorktreeCreate/WorktreeRemove hooks when missing", () => {
    const cwd = mkTmp();
    const result = ensureClaudeWorktreeHooks(cwd);
    expect(result.status).toBe("created");
    expect(readSettings(cwd)).toEqual({ hooks: expectedHooks });
  });

  test("is idempotent — a file already carrying the hooks is unchanged", () => {
    const cwd = mkTmp();
    expect(ensureClaudeWorktreeHooks(cwd).status).toBe("created");
    expect(ensureClaudeWorktreeHooks(cwd).status).toBe("unchanged");
  });

  test("merges into existing hooks + permissions without clobbering them", () => {
    const cwd = mkTmp();
    mkdirSync(join(cwd, ".claude"));
    writeFileSync(
      join(cwd, CLAUDE_LOCAL_SETTINGS_RELATIVE_PATH),
      JSON.stringify({
        permissions: { allow: ["Bash(prx:*)"] },
        hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "prx beads prime" }] }] },
      }),
    );
    const result = ensureClaudeWorktreeHooks(cwd);
    expect(result.status).toBe("updated");
    const settings = readSettings(cwd) as Record<string, any>;
    expect(settings.permissions).toEqual({ allow: ["Bash(prx:*)"] });
    expect(settings.hooks.SessionStart).toBeDefined(); // preserved
    expect(settings.hooks.WorktreeCreate).toEqual(expectedHooks.WorktreeCreate);
    expect(settings.hooks.WorktreeRemove).toEqual(expectedHooks.WorktreeRemove);
  });

  test("refuses to stomp malformed JSON", () => {
    const cwd = mkTmp();
    mkdirSync(join(cwd, ".claude"));
    writeFileSync(join(cwd, CLAUDE_LOCAL_SETTINGS_RELATIVE_PATH), "{ not: valid json");
    expect(ensureClaudeWorktreeHooks(cwd).status).toBe("skipped-malformed");
  });

  test("prx-hot: a repoAnchor dir bakes --repo into the commands (shell-quoted)", () => {
    const cwd = mkTmp();
    ensureClaudeWorktreeHooks(cwd, "/bare/prx.git");
    const settings = readSettings(cwd) as Record<string, any>;
    expect(settings.hooks.WorktreeCreate[0].hooks[0].command).toBe(
      `${WORKTREE_CREATE_HOOK_COMMAND} --repo '/bare/prx.git'`,
    );
    expect(settings.hooks.WorktreeRemove[0].hooks[0].command).toBe(
      `${WORKTREE_REMOVE_HOOK_COMMAND} --repo '/bare/prx.git'`,
    );
  });

  test("prx-hot: a repoAnchor slug bakes through too", () => {
    const cwd = mkTmp();
    ensureClaudeWorktreeHooks(cwd, "bounded-systems/prx");
    const settings = readSettings(cwd) as Record<string, any>;
    expect(settings.hooks.WorktreeCreate[0].hooks[0].command).toBe(
      `${WORKTREE_CREATE_HOOK_COMMAND} --repo 'bounded-systems/prx'`,
    );
  });

  test("prx-hot: no anchor → plain commands (unchanged from prx-5q3)", () => {
    const cwd = mkTmp();
    ensureClaudeWorktreeHooks(cwd);
    const settings = readSettings(cwd) as Record<string, any>;
    expect(settings.hooks.WorktreeCreate[0].hooks[0].command).toBe(WORKTREE_CREATE_HOOK_COMMAND);
  });
});
