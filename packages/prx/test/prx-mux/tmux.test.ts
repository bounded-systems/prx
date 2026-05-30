import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PRX_TMUX_SOCKET,
  muxSessionState,
  spawnMuxSession,
  attachMuxSession,
  killMuxSession,
  clearResurrectEntry,
  restoreMuxSession,
  sendMuxKeys,
  type CommandRunner,
  type CommandResult,
} from "@bounded-systems/prx-mux";

type Invocation = { cmd: string[]; options?: { cwd?: string; check?: boolean; env?: NodeJS.ProcessEnv } };

function recordingRunner(responses: Record<string, CommandResult>): { run: CommandRunner; invocations: Invocation[] } {
  const invocations: Invocation[] = [];
  const run: CommandRunner = (cmd, options = {}) => {
    invocations.push({ cmd: [...cmd], options });
    const key = cmd.join(" ");
    const matched =
      responses[key] ??
      Object.entries(responses).find(([k]) => key.startsWith(k))?.[1];
    if (!matched) {
      if (options.check !== false) {
        const err = Object.assign(new Error(`recordingRunner: no canned response for ${JSON.stringify(cmd)}`), {
          result: { stdout: "", stderr: "", status: 1 },
        });
        throw err;
      }
      return { stdout: "", stderr: "", status: 1 };
    }
    if (matched.status !== 0 && options.check !== false) {
      const err = Object.assign(new Error(matched.stderr || matched.stdout || "runner error"), { result: matched });
      throw err;
    }
    return matched;
  };
  return { run, invocations };
}

function ok(stdout = ""): CommandResult {
  return { stdout, stderr: "", status: 0 };
}
function notOk(stderr = ""): CommandResult {
  return { stdout: "", stderr, status: 1 };
}

describe("muxSessionState", () => {
  test("returns 'absent' when has-session fails and no resurrect save mentions the name", () => {
    const { run, invocations } = recordingRunner({
      "tmux -L prx has-session -t gh_678_abc": notOk(),
    });
    expect(muxSessionState("gh_678_abc", "/wt/gh_678_abc", run)).toBe("absent");
    expect(invocations.length).toBeGreaterThanOrEqual(1);
    // No session-path / session-attached queries should have been made.
    expect(invocations.some((i) => i.cmd.includes("display-message"))).toBe(false);
  });

  test("returns 'running-detached' when session exists with session_attached = 0", () => {
    const { run } = recordingRunner({
      "tmux -L prx has-session -t S": ok(),
      "tmux -L prx display-message -p -t S #{session_path}": ok("/wt/S"),
      "tmux -L prx display-message -p -t S #{session_attached}": ok("0"),
    });
    expect(muxSessionState("S", "/wt/S", run)).toBe("running-detached");
  });

  test("returns 'running-attached' when session exists and has >=1 client", () => {
    const { run } = recordingRunner({
      "tmux -L prx has-session -t S": ok(),
      "tmux -L prx display-message -p -t S #{session_path}": ok("/wt/S"),
      "tmux -L prx display-message -p -t S #{session_attached}": ok("1"),
    });
    expect(muxSessionState("S", "/wt/S", run)).toBe("running-attached");
  });

  test("collision guard (D2): raises when the session exists under a different worktree path", () => {
    const { run } = recordingRunner({
      "tmux -L prx has-session -t S": ok(),
      "tmux -L prx display-message -p -t S #{session_path}": ok("/other/path/S"),
    });
    expect(() => muxSessionState("S", "/wt/S", run)).toThrow(/different worktree/);
  });

  test("collision guard normalizes trailing slashes when comparing session_path to expected cwd", () => {
    const { run } = recordingRunner({
      "tmux -L prx has-session -t S": ok(),
      "tmux -L prx display-message -p -t S #{session_path}": ok("/wt/S/"),
      "tmux -L prx display-message -p -t S #{session_attached}": ok("0"),
    });
    expect(muxSessionState("S", "/wt/S", run)).toBe("running-detached");
  });
});

describe("spawnMuxSession", () => {
  test("creates a single detached session and replays the bootstrap command under -L prx", () => {
    const invocations: Invocation[] = [];
    const run: CommandRunner = (cmd, options = {}) => {
      invocations.push({ cmd: [...cmd], options });
      return ok("");
    };
    spawnMuxSession({
      name: "gh_678_abc",
      cwd: "/wt/gh_678_abc",
      layout: { bootstrap_command: "codex" },
      run,
    });

    expect(invocations.every((i) => i.cmd[0] === "tmux" && i.cmd[1] === "-L" && i.cmd[2] === PRX_TMUX_SOCKET)).toBe(true);

    const newSession = invocations.find((i) => i.cmd.includes("new-session"));
    expect(newSession?.cmd).toEqual([
      "tmux", "-L", PRX_TMUX_SOCKET,
      "new-session", "-d", "-s", "gh_678_abc",
      "-c", "/wt/gh_678_abc",
      "-n", "worktree",
    ]);

    // GH-767: single pane only — no splits.
    expect(invocations.some((i) => i.cmd.includes("split-window"))).toBe(false);

    const sendKeys = invocations.find((i) => i.cmd.includes("send-keys"));
    expect(sendKeys?.cmd).toEqual([
      "tmux", "-L", PRX_TMUX_SOCKET,
      "send-keys", "-t", "gh_678_abc", "codex", "Enter",
    ]);
  });

  test("skips send-keys entirely when no bootstrap_command is provided", () => {
    const invocations: Invocation[] = [];
    const run: CommandRunner = (cmd, options = {}) => {
      invocations.push({ cmd: [...cmd], options });
      return ok("");
    };
    spawnMuxSession({ name: "S", cwd: "/wt/S", layout: {}, run });
    expect(invocations.some((i) => i.cmd.includes("send-keys"))).toBe(false);
  });

  test("kills the half-built session if a layout step fails", () => {
    const invocations: Invocation[] = [];
    const run: CommandRunner = (cmd, options = {}) => {
      invocations.push({ cmd: [...cmd], options });
      if (cmd.includes("send-keys")) {
        const err = Object.assign(new Error("send-keys failed"), { result: notOk("send-keys failed") });
        throw err;
      }
      return ok("");
    };
    expect(() =>
      spawnMuxSession({ name: "S", cwd: "/wt/S", layout: { bootstrap_command: "claude" }, run }),
    ).toThrow(/send-keys failed/);
    const kills = invocations.filter((i) => i.cmd.includes("kill-session"));
    expect(kills.length).toBeGreaterThanOrEqual(1);
    expect(kills[0]?.cmd).toContain("S");
    expect(kills[0]?.options?.check).toBe(false);
  });
});

describe("sendMuxKeys", () => {
  test("targets the worktree pane, inserts --, and appends Enter by default", () => {
    const { run, invocations } = recordingRunner({
      "tmux -L prx send-keys -t S:worktree.0 -- /review Enter": ok(""),
    });
    sendMuxKeys({ name: "S", keys: "/review", run });
    expect(invocations[0]?.cmd).toEqual([
      "tmux", "-L", PRX_TMUX_SOCKET,
      "send-keys", "-t", "S:worktree.0", "--", "/review", "Enter",
    ]);
  });

  test("omits trailing Enter when submit: false (pre-fill only)", () => {
    const { run, invocations } = recordingRunner({
      "tmux -L prx send-keys -t S:worktree.0 -- /ultrareview": ok(""),
    });
    sendMuxKeys({ name: "S", keys: "/ultrareview", submit: false, run });
    expect(invocations[0]?.cmd).toEqual([
      "tmux", "-L", PRX_TMUX_SOCKET,
      "send-keys", "-t", "S:worktree.0", "--", "/ultrareview",
    ]);
    expect(invocations[0]?.cmd).not.toContain("Enter");
  });

  test("explicit submit: true still appends Enter", () => {
    const { run, invocations } = recordingRunner({
      "tmux -L prx send-keys -t S:worktree.0 -- /review Enter": ok(""),
    });
    sendMuxKeys({ name: "S", keys: "/review", submit: true, run });
    expect(invocations[0]?.cmd).toEqual([
      "tmux", "-L", PRX_TMUX_SOCKET,
      "send-keys", "-t", "S:worktree.0", "--", "/review", "Enter",
    ]);
  });
});

describe("attachMuxSession (via injected runner — production path uses spawnSync)", () => {
  test("emits attach-session under the prx socket and returns the runner status", () => {
    const { run, invocations } = recordingRunner({
      "tmux -L prx attach-session -t S": { stdout: "", stderr: "", status: 0 },
    });
    const result = attachMuxSession({ name: "S", run });
    expect(result.status).toBe(0);
    expect(invocations[0]?.cmd).toEqual(["tmux", "-L", "prx", "attach-session", "-t", "S"]);
  });
});

describe("killMuxSession", () => {
  test("detaches clients, kills the session, then clears the resurrect entry (order-sensitive)", () => {
    const dir = mkdtempSync(join(tmpdir(), "prx-mux-"));
    writeFileSync(join(dir, "save.txt"), `pane\tS\tfoo\npane\tOther\tbar\n`);
    symlinkSync("save.txt", join(dir, "last"));
    const resurrectDir = dir + "/";

    const calls: string[][] = [];
    const run: CommandRunner = (cmd) => {
      calls.push([...cmd]);
      return ok("");
    };
    killMuxSession({ name: "S", run, resurrectDir });

    expect(calls[0]?.slice(3)).toEqual(["detach-client", "-s", "S"]);
    expect(calls[1]?.slice(3)).toEqual(["kill-session", "-t", "S"]);
    const after = readFileSync(join(dir, "save.txt"), "utf8");
    expect(after).not.toContain("\tS\t");
    expect(after).toContain("\tOther\t");
  });
});

describe("clearResurrectEntry", () => {
  test("is a no-op when the resurrect dir doesn't exist", () => {
    expect(() => clearResurrectEntry({ name: "S", resurrectDir: "/does/not/exist-" + Date.now() + "/" })).not.toThrow();
  });

  test("drops only lines whose 2nd tab-delimited column matches the session name", () => {
    const dir = mkdtempSync(join(tmpdir(), "prx-mux-"));
    const save = join(dir, "save.txt");
    writeFileSync(
      save,
      [
        "pane\tgh_100\teditor\tcmd",
        "window\tgh_100\t1",
        "pane\tgh_200\teditor\tcmd",
        "state\tgh_200",
        "",
      ].join("\n"),
    );
    symlinkSync("save.txt", join(dir, "last"));

    clearResurrectEntry({ name: "gh_100", resurrectDir: dir + "/" });

    const after = readFileSync(save, "utf8");
    expect(after).not.toContain("\tgh_100\t");
    expect(after).toContain("\tgh_200\t");
    // state line has gh_200 in column 2 → untouched
    expect(after).toContain("state\tgh_200");
  });

  test("does not rewrite the save file when no lines match", () => {
    const dir = mkdtempSync(join(tmpdir(), "prx-mux-"));
    const save = join(dir, "save.txt");
    const contents = "pane\tgh_200\teditor\n";
    writeFileSync(save, contents);
    symlinkSync("save.txt", join(dir, "last"));
    const mtimeBefore = (require("node:fs") as typeof import("node:fs")).statSync(save).mtimeMs;

    // Sleep briefly to ensure mtime resolution would show a change if we wrote.
    const t0 = Date.now();
    while (Date.now() - t0 < 5) { /* spin */ }

    clearResurrectEntry({ name: "gh_100", resurrectDir: dir + "/" });

    const mtimeAfter = (require("node:fs") as typeof import("node:fs")).statSync(save).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
    expect(readFileSync(save, "utf8")).toBe(contents);
  });

  test("handles an absent 'last' symlink gracefully", () => {
    const dir = mkdtempSync(join(tmpdir(), "prx-mux-"));
    mkdirSync(dir, { recursive: true });
    expect(() => clearResurrectEntry({ name: "gh_1", resurrectDir: dir + "/" })).not.toThrow();
  });
});

describe("restoreMuxSession (Slice 5 script discovery)", () => {
  test("uses the explicit restoreScript when passed", () => {
    const { run, invocations } = recordingRunner({
      "tmux -L prx run-shell /explicit/restore.sh": ok(""),
    });
    restoreMuxSession({ run, restoreScript: "/explicit/restore.sh" });
    // show-option is NOT queried when a restoreScript is passed.
    expect(invocations.some((i) => i.cmd.includes("show-option"))).toBe(false);
    expect(invocations[0]?.cmd).toEqual(["tmux", "-L", PRX_TMUX_SOCKET, "run-shell", "/explicit/restore.sh"]);
  });

  test("discovers restoreScript via @prx-resurrect-script tmux option", () => {
    const { run, invocations } = recordingRunner({
      "tmux -L prx show-option -gqv @prx-resurrect-script": ok("/nix/store/xxx/restore.sh\n"),
      "tmux -L prx run-shell /nix/store/xxx/restore.sh": ok(""),
    });
    restoreMuxSession({ run });
    const showOpt = invocations.find((i) => i.cmd.includes("show-option"));
    expect(showOpt?.cmd).toEqual(["tmux", "-L", PRX_TMUX_SOCKET, "show-option", "-gqv", "@prx-resurrect-script"]);
    const runShell = invocations.find((i) => i.cmd.includes("run-shell"));
    expect(runShell?.cmd).toEqual(["tmux", "-L", PRX_TMUX_SOCKET, "run-shell", "/nix/store/xxx/restore.sh"]);
  });

  test("throws with a helpful message when @prx-resurrect-script is unset", () => {
    const { run } = recordingRunner({
      "tmux -L prx show-option -gqv @prx-resurrect-script": ok(""),
    });
    expect(() => restoreMuxSession({ run })).toThrow(/@prx-resurrect-script|programs\.tmux-prx/);
  });

  test("throws when the show-option call itself fails (server dead, no -L prx)", () => {
    const { run } = recordingRunner({
      "tmux -L prx show-option -gqv @prx-resurrect-script": notOk("no server running"),
    });
    expect(() => restoreMuxSession({ run })).toThrow();
  });
});
