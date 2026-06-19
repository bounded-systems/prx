import { describe, expect, test } from "bun:test";
import {
  resolveWorktreePath,
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
    expect(result.template).toBe(`/home/test/.local/state/${WT_SUBDIRECTORY}/${TEMPLATE_SUFFIX}`);
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

  test("canonical path template", () => {
    const result = resolveWorktreePath({
      HOME: "/home/test",
    });
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
