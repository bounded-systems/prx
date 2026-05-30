import { describe, expect, test } from "bun:test";

import {
  parseTmuxConfig,
  runTmuxReconcile,
  type TmuxReconcileDeps,
  type TmuxReconcileSpawnResult,
} from "../../src/pr-state/tmux-reconcile.ts";

type SpawnCall = {
  file: string;
  args: string[];
};

function makeFixture(params: {
  configText: string;
  configPath?: string;
  showResults: Map<string, string | { stderr: string; status: number }>;
  hasSession?: TmuxReconcileSpawnResult;
  setResults?: Map<string, TmuxReconcileSpawnResult>;
}) {
  const logs: string[] = [];
  const errs: string[] = [];
  const calls: SpawnCall[] = [];
  const configPath = params.configPath ?? "/home/test/.config/tmux/tmux.conf";
  const showResults = new Map(params.showResults);
  const setResults = new Map(params.setResults ?? []);

  const deps: TmuxReconcileDeps = {
    spawn: (file, args) => {
      calls.push({ file, args });
      if (file !== "tmux") return { status: 0, stdout: "" };
      // args: -L <socket> <verb> ...
      const verb = args[2];
      if (verb === "has-session") {
        return params.hasSession ?? { status: 0 };
      }
      if (verb === "show-option") {
        const option = args[args.length - 1] ?? "";
        const r = showResults.get(option);
        if (typeof r === "string") return { status: 0, stdout: r };
        if (r && typeof r === "object") return { status: r.status, stderr: r.stderr };
        return { status: 0, stdout: "" };
      }
      if (verb === "set-option") {
        const option = args[args.length - 2] ?? "";
        return setResults.get(option) ?? { status: 0 };
      }
      return { status: 0, stdout: "" };
    },
    readFile: (p: string) => {
      if (p !== configPath) throw new Error(`unexpected read: ${p}`);
      return params.configText;
    },
    pathExists: (p: string) => p === configPath,
    env: {},
    homeDir: "/home/test",
  };

  const output = {
    log: (l: string) => logs.push(l),
    error: (l: string) => errs.push(l),
  };

  return { logs, errs, calls, deps, configPath };
}

describe("parseTmuxConfig", () => {
  test("extracts global scalar options from set -g lines", () => {
    const parsed = parseTmuxConfig(
      [
        "# comment",
        "set -g focus-events on",
        "set -g allow-rename on",
        "set-option -g mouse on",
        "setw -g automatic-rename on",
        "set -g set-titles on",
        "",
      ].join("\n"),
    );
    expect(parsed.options.get("focus-events")).toEqual({ scope: "global", value: "on" });
    expect(parsed.options.get("allow-rename")).toEqual({ scope: "global", value: "on" });
    expect(parsed.options.get("mouse")).toEqual({ scope: "global", value: "on" });
    expect(parsed.options.get("automatic-rename")).toEqual({ scope: "window", value: "on" });
    expect(parsed.options.get("set-titles")).toEqual({ scope: "global", value: "on" });
    expect(parsed.unsupported).toEqual([]);
  });

  test("strips quotes and trailing comments from values", () => {
    const parsed = parseTmuxConfig(
      [
        "set -g status-bg 'colour234' # status bar background",
        'set -g escape-time "10"',
      ].join("\n"),
    );
    expect(parsed.options.get("status-bg")).toEqual({ scope: "global", value: "colour234" });
    expect(parsed.options.get("escape-time")).toEqual({ scope: "global", value: "10" });
  });

  test("flags hooks, plugins, source-file, bindings, and user options as unsupported", () => {
    const parsed = parseTmuxConfig(
      [
        "set -g @resurrect-dir '/tmp/resurrect'",
        "set -g @prx-resurrect-script '/nix/store/x'",
        "set-hook -g pane-title-changed 'run-shell foo'",
        "run-shell '/nix/store/plugin/init.sh'",
        "source-file '/etc/tmux.extra.conf'",
        "bind r source-file ~/.tmux.conf",
        "set -g focus-events on",
      ].join("\n"),
    );
    expect(parsed.options.has("@resurrect-dir")).toBe(false);
    expect(parsed.options.has("@prx-resurrect-script")).toBe(false);
    expect(parsed.options.get("focus-events")).toEqual({ scope: "global", value: "on" });

    const kinds = parsed.unsupported.map((u) => u.kind).sort();
    expect(kinds).toEqual(["bind", "hook", "plugin", "source-file", "user-option", "user-option"]);
  });

  test("folds backslash-continued lines", () => {
    const parsed = parseTmuxConfig(
      ["set -g status-format \\", "  'left right' # trailing"].join("\n"),
    );
    expect(parsed.options.get("status-format")).toEqual({ scope: "global", value: "left right" });
  });

  test("skips set lines without -g (session-local)", () => {
    const parsed = parseTmuxConfig("set focus-events on\nset -g focus-events on\n");
    expect(parsed.options.get("focus-events")).toEqual({ scope: "global", value: "on" });
  });

  test("flags -u/-a/-F/-o forms as unparseable (do not auto-reconcile)", () => {
    const parsed = parseTmuxConfig(
      [
        "set -gu focus-events",
        "set -ga update-environment ' SSH_AUTH_SOCK'",
        "set -g focus-events on",
      ].join("\n"),
    );
    expect(parsed.options.get("focus-events")).toEqual({ scope: "global", value: "on" });
    expect(parsed.unsupported.map((u) => u.kind)).toEqual(["unparseable", "unparseable"]);
  });
});

describe("runTmuxReconcile", () => {
  test("server not running: returns inSync no-op without spawning show-option", () => {
    const fx = makeFixture({
      configText: "set -g focus-events on\n",
      hasSession: { status: 1 },
      showResults: new Map(),
    });
    const code = runTmuxReconcile(
      { socket: "prx", dryRun: false, format: "json" },
      { log: (l) => fx.logs.push(l), error: (l) => fx.errs.push(l) },
      fx.deps,
    );
    expect(code).toBe(0);
    const json = JSON.parse(fx.logs[0]!);
    expect(json.serverRunning).toBe(false);
    expect(json.inSync).toBe(true);
    expect(json.applied).toEqual([]);
    // show-option should not have been called.
    expect(fx.calls.filter((c) => c.args.includes("show-option"))).toEqual([]);
  });

  test("apply: emits set-option for each diverged option and reports applied", () => {
    const fx = makeFixture({
      configText:
        "set -g focus-events on\nset -g allow-rename on\nset -g mouse on\n",
      showResults: new Map<string, string>([
        ["focus-events", "off"],
        ["allow-rename", "off"],
        ["mouse", "on"],
      ]),
    });
    const code = runTmuxReconcile(
      { socket: "prx", dryRun: false, format: "json" },
      { log: (l) => fx.logs.push(l), error: (l) => fx.errs.push(l) },
      fx.deps,
    );
    expect(code).toBe(0);
    const json = JSON.parse(fx.logs[0]!);
    expect(json.serverRunning).toBe(true);
    expect(json.checked).toBe(3);
    expect(json.applied.map((a: { option: string; status: string }) => [a.option, a.status]).sort())
      .toEqual([
        ["allow-rename", "applied"],
        ["focus-events", "applied"],
      ]);
    expect(json.inSync).toBe(false);
    // Verify a set-option call was emitted with the desired value.
    const setCalls = fx.calls.filter((c) => c.args.includes("set-option"));
    expect(setCalls.map((c) => c.args.slice(-2))).toEqual([
      ["allow-rename", "on"],
      ["focus-events", "on"],
    ]);
  });

  test("dry-run: marks deltas as would-apply and does not spawn set-option", () => {
    const fx = makeFixture({
      configText: "set -g focus-events on\n",
      showResults: new Map<string, string>([["focus-events", "off"]]),
    });
    const code = runTmuxReconcile(
      { socket: "prx", dryRun: true, format: "json" },
      { log: (l) => fx.logs.push(l), error: (l) => fx.errs.push(l) },
      fx.deps,
    );
    expect(code).toBe(0);
    const json = JSON.parse(fx.logs[0]!);
    expect(json.applied).toEqual([
      {
        option: "focus-events",
        scope: "global",
        from: "off",
        to: "on",
        command: "tmux -L prx set -g focus-events on",
        status: "would-apply",
        exitCode: 0,
      },
    ]);
    expect(fx.calls.filter((c) => c.args.includes("set-option"))).toEqual([]);
  });

  test("idempotent: identical live and config values report in sync", () => {
    const fx = makeFixture({
      configText: "set -g focus-events on\nset -g allow-rename on\n",
      showResults: new Map<string, string>([
        ["focus-events", "on"],
        ["allow-rename", "on"],
      ]),
    });
    const code = runTmuxReconcile(
      { socket: "prx", dryRun: false, format: "plain" },
      { log: (l) => fx.logs.push(l), error: (l) => fx.errs.push(l) },
      fx.deps,
    );
    expect(code).toBe(0);
    expect(fx.logs.join("\n")).toContain("prx: in sync (2 options checked)");
  });

  test("apply failure: returns exit 1 and marks delta failed", () => {
    const fx = makeFixture({
      configText: "set -g focus-events on\n",
      showResults: new Map<string, string>([["focus-events", "off"]]),
      setResults: new Map([
        ["focus-events", { status: 1, stderr: "permission denied" }],
      ]),
    });
    const code = runTmuxReconcile(
      { socket: "prx", dryRun: false, format: "json" },
      { log: (l) => fx.logs.push(l), error: (l) => fx.errs.push(l) },
      fx.deps,
    );
    expect(code).toBe(1);
    const json = JSON.parse(fx.logs[0]!);
    expect(json.applied[0].status).toBe("failed");
    expect(json.applied[0].stderrTail).toBe("permission denied");
  });

  test("missing tmux.conf: returns exit 2 with error", () => {
    const deps: TmuxReconcileDeps = {
      spawn: () => ({ status: 0 }),
      pathExists: () => false,
      env: {},
      homeDir: "/home/test",
    };
    const logs: string[] = [];
    const code = runTmuxReconcile(
      { socket: "prx", dryRun: false, format: "json" },
      { log: (l) => logs.push(l), error: () => {} },
      deps,
    );
    expect(code).toBe(2);
    const json = JSON.parse(logs[0]!);
    expect(json.errors[0]).toMatch(/tmux\.conf not found/);
  });

  test("hook/plugin lines surface as unsupported note in plain output", () => {
    const fx = makeFixture({
      configText: [
        "set -g focus-events on",
        "set-hook -g pane-title-changed 'run-shell foo'",
        "set -g @resurrect-dir '/tmp/x'",
      ].join("\n"),
      showResults: new Map<string, string>([["focus-events", "on"]]),
    });
    const code = runTmuxReconcile(
      { socket: "prx", dryRun: false, format: "plain" },
      { log: (l) => fx.logs.push(l), error: (l) => fx.errs.push(l) },
      fx.deps,
    );
    expect(code).toBe(0);
    expect(fx.logs.join("\n")).toContain("hook/plugin/user-option line(s) skipped");
  });

  test("XDG_CONFIG_HOME is respected for default config path", () => {
    const calls: SpawnCall[] = [];
    const reads: string[] = [];
    const deps: TmuxReconcileDeps = {
      spawn: (file, args) => {
        calls.push({ file, args });
        if (args[2] === "has-session") return { status: 1 };
        return { status: 0, stdout: "" };
      },
      readFile: (p: string) => {
        reads.push(p);
        return "set -g focus-events on\n";
      },
      pathExists: (p: string) => p === "/xdg/tmux/tmux.conf",
      env: { XDG_CONFIG_HOME: "/xdg" },
      homeDir: "/home/test",
    };
    const code = runTmuxReconcile(
      { socket: "prx", dryRun: false, format: "json" },
      { log: () => {}, error: () => {} },
      deps,
    );
    expect(code).toBe(0);
    expect(reads).toEqual(["/xdg/tmux/tmux.conf"]);
  });
});
