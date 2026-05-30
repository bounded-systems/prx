import { describe, test, expect } from "bun:test";

import {
  compileLayout,
  muxSessionName,
} from "@bounded-systems/prx-mux";

describe("muxSessionName", () => {
  test("uses the basename of a standard worktrunk path unchanged", () => {
    expect(muxSessionName("/Users/dev/.local/state/wt/worktrees/main/gh_632_joyful")).toBe("gh_632_joyful");
  });

  test("strips trailing slashes before taking the basename", () => {
    expect(muxSessionName("/Users/dev/worktrees/gh_678_abc/")).toBe("gh_678_abc");
    expect(muxSessionName("/Users/dev/worktrees/gh_678_abc///")).toBe("gh_678_abc");
  });

  test("sanitizes chars outside [A-Za-z0-9_-] to underscores (D2 collision-prone inputs)", () => {
    expect(muxSessionName("/tmp/weird.dir")).toBe("weird_dir");
    expect(muxSessionName("/tmp/has:colon")).toBe("has_colon");
    expect(muxSessionName("/tmp/has space")).toBe("has_space");
  });

  test("throws when the derived basename would be empty", () => {
    expect(() => muxSessionName("/")).toThrow(/empty session name/);
    expect(() => muxSessionName("")).toThrow(/empty session name/);
  });

  test("is a pure function of the path", () => {
    const p = "/Users/dev/worktrees/gh_42_foo";
    expect(muxSessionName(p)).toBe(muxSessionName(p));
  });

  // GH-1172: optional mode parameter so plan and implement sessions for the
  // same worktree coexist on the prx tmux socket without colliding.
  test("appends `-<mode>` when a mode is provided", () => {
    expect(muxSessionName("/wt/gh_1172_c5h", "plan")).toBe("gh_1172_c5h-plan");
    expect(muxSessionName("/wt/gh_1172_c5h", "implement")).toBe("gh_1172_c5h-implement");
  });

  test("omits the mode suffix when mode is undefined (back-compat with un-tagged callers)", () => {
    expect(muxSessionName("/wt/gh_1172_c5h")).toBe("gh_1172_c5h");
    expect(muxSessionName("/wt/gh_1172_c5h", undefined)).toBe("gh_1172_c5h");
  });

  test("sanitizes characters in the mode suffix using the same rule as the basename", () => {
    // tmux rejects `:` in session names (the layout doc-comment notes this);
    // sanitizing to `_` keeps the on-disk separator `-` unambiguous.
    expect(muxSessionName("/wt/gh_1172_c5h", "weird:mode")).toBe("gh_1172_c5h-weird_mode");
  });

  test("throws when the mode sanitizes to an empty string", () => {
    expect(() => muxSessionName("/wt/gh_1172_c5h", "")).toThrow(/empty mode suffix/);
  });
});

describe("compileLayout", () => {
  test("creates a single detached session with CWD and window name 'worktree'", () => {
    const steps = compileLayout("gh_678_abc", "/wt/gh_678_abc", {});
    expect(steps).toHaveLength(1);
    expect(steps[0]?.args).toEqual([
      "new-session", "-d", "-s", "gh_678_abc",
      "-c", "/wt/gh_678_abc",
      "-n", "worktree",
    ]);
  });

  test("does not split — GH-767 removed the 4-pane default", () => {
    const steps = compileLayout("S", "/w", { bootstrap_command: "claude" });
    const splits = steps.filter((s) => s.args.includes("split-window"));
    expect(splits).toHaveLength(0);
  });

  test("appends send-keys with the bootstrap command when provided", () => {
    const steps = compileLayout("S", "/w", { bootstrap_command: "claude --mode full" });
    expect(steps).toHaveLength(2);
    expect(steps[1]?.args).toEqual(["send-keys", "-t", "S", "claude --mode full", "Enter"]);
  });

  test("omits send-keys when no bootstrap_command is provided", () => {
    const steps = compileLayout("S", "/w", {});
    const sendKeys = steps.filter((s) => s.args[0] === "send-keys");
    expect(sendKeys).toHaveLength(0);
  });

  test("pane_command emits a single new-session with argv as trailing shell-command (GH-819)", () => {
    const steps = compileLayout("gh_819_abc", "/wt/gh_819_abc", {
      pane_command: {
        argv: ["claude", "--name", "GH-819", "--permission-mode", "plan"],
      },
    });
    expect(steps).toHaveLength(1);
    expect(steps[0]?.args).toEqual([
      "new-session", "-d", "-s", "gh_819_abc",
      "-c", "/wt/gh_819_abc",
      "-n", "worktree",
      "claude", "--name", "GH-819", "--permission-mode", "plan",
    ]);
    const sendKeys = steps.filter((s) => s.args[0] === "send-keys");
    expect(sendKeys).toHaveLength(0);
  });

  test("pane_command with remain_on_exit adds set-window-option remain-on-exit failed (GH-856)", () => {
    const steps = compileLayout("S", "/w", {
      pane_command: {
        argv: ["claude", "--name", "GH-1"],
        remain_on_exit: true,
      },
    });
    expect(steps).toHaveLength(2);
    expect(steps[1]?.args).toEqual([
      "set-window-option", "-t", "S:worktree", "remain-on-exit", "failed",
    ]);
  });

  test("pane_command without remain_on_exit omits the set-window-option step", () => {
    const steps = compileLayout("S", "/w", {
      pane_command: { argv: ["claude"] },
    });
    expect(steps).toHaveLength(1);
    const setOpt = steps.filter((s) => s.args[0] === "set-window-option");
    expect(setOpt).toHaveLength(0);
  });

  test("pane_command and bootstrap_command together throws (mutually exclusive)", () => {
    expect(() =>
      compileLayout("S", "/w", {
        pane_command: { argv: ["claude"] },
        bootstrap_command: "claude",
      }),
    ).toThrow(/mutually exclusive/);
  });
});
