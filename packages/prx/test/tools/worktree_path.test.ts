import { describe, expect, test } from "bun:test";
import {
  resolveWorktreePath,
  worktreeEnv,
  formatWorktreePath,
  formatWorktreeEnv,
  WT_SUBDIRECTORY,
  TEMPLATE_SUFFIX,
} from "../../src/tools/worktree_path.ts";

describe("resolveWorktreePath", () => {
  test("uses WT_WORKTREE_PATH when set", () => {
    const result = resolveWorktreePath({
      WT_WORKTREE_PATH: "/custom/path/{{ repo }}/{{ branch | sanitize_db }}",
      HOME: "/home/test",
    });
    expect(result.source).toBe("WT_WORKTREE_PATH");
    expect(result.template).toBe("/custom/path/{{ repo }}/{{ branch | sanitize_db }}");
    expect(result.env.WORKTRUNK_WORKTREE_PATH).toBe(result.template);
    expect(result.env.WT_WORKTREE_PATH).toBe(result.template);
  });

  test("falls back to XDG_STATE_HOME when WT_WORKTREE_PATH not set", () => {
    const result = resolveWorktreePath({
      XDG_STATE_HOME: "/home/test/.local/state",
      HOME: "/home/test",
    });
    expect(result.source).toBe("XDG_STATE_HOME");
    expect(result.template).toBe(
      `/home/test/.local/state/${WT_SUBDIRECTORY}/${TEMPLATE_SUFFIX}`,
    );
    expect(result.base).toBe("/home/test/.local/state/wt/worktrees");
  });

  test("falls back to default XDG path when nothing set", () => {
    const result = resolveWorktreePath({
      HOME: "/home/test",
    });
    expect(result.source).toBe("default");
    expect(result.template).toContain("/home/test/.local/state/wt/worktrees/");
    expect(result.xdgStateHome).toBe("/home/test/.local/state");
  });

  test("config and wrapper produce same path template", () => {
    const result = resolveWorktreePath({
      HOME: "/home/test",
    });
    // This is the canonical path that must match config.toml
    expect(result.template).toContain("wt/worktrees/{{ repo }}/{{ branch | sanitize_db }}");
    // Must NOT contain the old divergent git/worktrees path
    expect(result.template).not.toContain("git/worktrees/{{ repo }}");
  });

  test("WT_WORKTREE_PATH and WORKTRUNK_WORKTREE_PATH are always equal", () => {
    const cases = [
      { WT_WORKTREE_PATH: "/explicit/{{ repo }}/{{ branch | sanitize_db }}", HOME: "/h" },
      { XDG_STATE_HOME: "/xdg", HOME: "/h" },
      { HOME: "/h" },
    ];
    for (const env of cases) {
      const result = resolveWorktreePath(env);
      expect(result.env.WT_WORKTREE_PATH).toBe(result.env.WORKTRUNK_WORKTREE_PATH);
    }
  });
});

describe("worktreeEnv", () => {
  test("produces shell-eval-safe output", () => {
    const result = worktreeEnv({ HOME: "/home/test" });
    expect(result.shell).toContain("export WT_WORKTREE_PATH=");
    expect(result.shell).toContain("export WORKTRUNK_WORKTREE_PATH=");
    expect(result.shell).toContain("export WT_STATE_ROOT=");
  });

  test("vars match between shell and object", () => {
    const result = worktreeEnv({ HOME: "/home/test" });
    expect(result.vars.WT_WORKTREE_PATH).toBeDefined();
    expect(result.vars.WORKTRUNK_WORKTREE_PATH).toBeDefined();
    expect(result.vars.WT_STATE_ROOT).toBeDefined();
    // Shell output should contain each var value
    for (const [key, value] of Object.entries(result.vars)) {
      expect(result.shell).toContain(`${key}="${value}"`);
    }
  });
});

describe("formatWorktreePath", () => {
  test("plain format is human-readable", () => {
    const result = resolveWorktreePath({ HOME: "/home/test" });
    const plain = formatWorktreePath(result, "plain");
    expect(plain).toContain("template:");
    expect(plain).toContain("source:");
    expect(plain).toContain("Export:");
  });

  test("json format is valid JSON", () => {
    const result = resolveWorktreePath({ HOME: "/home/test" });
    const json = formatWorktreePath(result, "json");
    const parsed = JSON.parse(json);
    expect(parsed.template).toBe(result.template);
    expect(parsed.source).toBe(result.source);
    expect(parsed.env.WT_WORKTREE_PATH).toBe(result.env.WT_WORKTREE_PATH);
  });
});

describe("formatWorktreeEnv", () => {
  test("plain format is eval-safe shell", () => {
    const result = worktreeEnv({ HOME: "/home/test" });
    const plain = formatWorktreeEnv(result, "plain");
    expect(plain).toContain("export ");
    // Every line should be an export statement
    for (const line of plain.split("\n")) {
      if (line.trim()) {
        expect(line).toMatch(/^export [A-Z_]+=".+"$/);
      }
    }
  });

  test("json format is valid JSON", () => {
    const result = worktreeEnv({ HOME: "/home/test" });
    const json = formatWorktreeEnv(result, "json");
    const parsed = JSON.parse(json);
    expect(parsed.vars).toBeDefined();
    expect(parsed.shell).toBeDefined();
  });
});
