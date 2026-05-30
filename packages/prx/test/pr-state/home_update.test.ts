import { describe, expect, test } from "bun:test";

import {
  runHomeUpdate,
  resolveFlakeDir,
  resolveInputName,
  type HomeUpdateOptions,
  type HomeUpdateDeps,
  type HomeUpdateSpawnResult,
} from "../../src/pr-state/home-update.ts";
import { runCli } from "../../src/pr-state/cli.ts";

type SpawnCall = {
  file: string;
  args: string[];
  cwd: string;
  stdio: "inherit" | "pipe" | "ignore" | undefined;
};

function makeFixture(params: {
  revs: Array<string | null>;
  spawnResults: HomeUpdateSpawnResult[];
  existingPaths?: Set<string>;
  inputName?: string;
  extraNodes?: Record<string, { locked: { rev: string } }>;
}) {
  const logs: string[] = [];
  const errs: string[] = [];
  const spawnCalls: SpawnCall[] = [];
  const revs = [...params.revs];
  const spawnResults = [...params.spawnResults];
  const inputName = params.inputName ?? "ai-home";
  const defaultExisting = new Set(
    params.existingPaths
      ? Array.from(params.existingPaths)
      : [
          "/fake/flake",
          "/fake/flake/flake.nix",
          "/fake/flake/flake.lock",
        ],
  );

  const readFile = (_path: string) => {
    const rev = revs.shift();
    const nodes: Record<string, { locked: { rev: string } }> = {
      ...(params.extraNodes ?? {}),
    };
    if (rev !== undefined && rev !== null) {
      nodes[inputName] = { locked: { rev } };
    } else if (rev === null) {
      // Input present but no rev.
      nodes[inputName] = { locked: { rev: "" } };
    }
    return JSON.stringify({ nodes });
  };

  const deps: HomeUpdateDeps = {
    spawn: (file, args, opts) => {
      spawnCalls.push({
        file,
        args,
        cwd: opts.cwd,
        stdio: opts.stdio,
      });
      const next = spawnResults.shift();
      return next ?? { status: 0 };
    },
    readFile,
    pathExists: (path: string) => defaultExisting.has(path),
    env: {},
    homeDir: "/home/test",
  };

  const output = {
    log: (line: string) => logs.push(line),
    error: (line: string) => errs.push(line),
  };

  return { logs, errs, spawnCalls, deps, output };
}

describe("resolveFlakeDir", () => {
  test("flag wins over env and default", () => {
    const opts: HomeUpdateOptions = {
      flakeDir: "~/custom",
      dryRun: false,
      format: "plain",
    };
    const dir = resolveFlakeDir(opts, { PRX_HOME_FLAKE_DIR: "~/other" }, "/home/me");
    expect(dir).toBe("/home/me/custom");
  });

  test("env wins over default", () => {
    const opts: HomeUpdateOptions = { dryRun: false, format: "plain" };
    const dir = resolveFlakeDir(opts, { PRX_HOME_FLAKE_DIR: "~/env-dir" }, "/home/me");
    expect(dir).toBe("/home/me/env-dir");
  });

  test("default is ~/.config/home-manager", () => {
    const opts: HomeUpdateOptions = { dryRun: false, format: "plain" };
    const dir = resolveFlakeDir(opts, {}, "/home/me");
    expect(dir).toBe("/home/me/.config/home-manager");
  });
});

describe("resolveInputName", () => {
  test("flag beats env beats default ai-home", () => {
    expect(
      resolveInputName({ input: "custom", dryRun: false, format: "plain" }, {}),
    ).toBe("custom");
    expect(
      resolveInputName(
        { dryRun: false, format: "plain" },
        { PRX_HOME_FLAKE_INPUT: "env-input" },
      ),
    ).toBe("env-input");
    expect(resolveInputName({ dryRun: false, format: "plain" }, {})).toBe("ai-home");
  });
});

describe("runHomeUpdate", () => {
  test("happy path runs nix flake update then home-manager switch and prints rev diff", () => {
    const fx = makeFixture({
      revs: ["aaaaaaaaaa1111", "bbbbbbbbbb2222"],
      spawnResults: [{ status: 0 }, { status: 0 }],
    });

    const exit = runHomeUpdate(
      {
        flakeDir: "/fake/flake",
        input: "ai-home",
        dryRun: false,
        format: "plain",
      },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(0);
    expect(fx.spawnCalls).toHaveLength(2);
    expect(fx.spawnCalls[0]!).toEqual({
      file: "nix",
      args: ["flake", "update", "ai-home", "--flake", "/fake/flake"],
      cwd: "/fake/flake",
      stdio: "inherit",
    });
    expect(fx.spawnCalls[1]).toEqual({
      file: "home-manager",
      args: ["switch", "--flake", "/fake/flake"],
      cwd: "/fake/flake",
      stdio: "inherit",
    });
    expect(fx.logs.join("\n")).toContain("ai-home: aaaaaaa → bbbbbbb (home-manager switched)");
    expect(fx.errs).toEqual([]);
  });

  test("detects no-op when rev unchanged", () => {
    const fx = makeFixture({
      revs: ["same1234567890", "same1234567890"],
      spawnResults: [{ status: 0 }, { status: 0 }],
    });

    const exit = runHomeUpdate(
      { flakeDir: "/fake/flake", dryRun: false, format: "plain" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(0);
    expect(fx.logs.join("\n")).toContain("ai-home: no-op (same123) — home-manager switched");
  });

  test("dry-run prints commands but does not spawn", () => {
    const fx = makeFixture({
      revs: ["aaaaaaaaaa1111"],
      spawnResults: [],
    });

    const exit = runHomeUpdate(
      { flakeDir: "/fake/flake", dryRun: true, format: "plain" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(0);
    expect(fx.spawnCalls).toEqual([]);
    const joined = fx.logs.join("\n");
    expect(joined).toContain("prx home update (dry-run)");
    expect(joined).toContain("nix flake update ai-home --flake /fake/flake");
    expect(joined).toContain("home-manager switch");
    expect(joined).toContain("aaaaaaa");
  });

  test("dry-run JSON payload includes from rev and command arrays", () => {
    const fx = makeFixture({
      revs: ["aaaaaaaaaa1111"],
      spawnResults: [],
    });

    const exit = runHomeUpdate(
      { flakeDir: "/fake/flake", dryRun: true, format: "json" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(0);
    const parsed = JSON.parse(fx.logs[0]!);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.flakeDir).toBe("/fake/flake");
    expect(parsed.input).toBe("ai-home");
    expect(parsed.from).toBe("aaaaaaaaaa1111");
    expect(parsed.commands[0]).toEqual([
      "nix",
      "flake",
      "update",
      "ai-home",
      "--flake",
      "/fake/flake",
    ]);
    expect(parsed.commands[1]).toEqual([
      "home-manager",
      "switch",
      "--flake",
      "/fake/flake",
    ]);
  });

  test("missing flake dir exits 2", () => {
    const fx = makeFixture({
      revs: [],
      spawnResults: [],
      existingPaths: new Set(),
    });

    const exit = runHomeUpdate(
      { flakeDir: "/fake/flake", dryRun: false, format: "plain" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(2);
    expect(fx.errs.join("\n")).toContain("flake dir does not exist");
    expect(fx.spawnCalls).toEqual([]);
  });

  test("missing flake.nix exits 2", () => {
    const fx = makeFixture({
      revs: [],
      spawnResults: [],
      existingPaths: new Set(["/fake/flake"]),
    });

    const exit = runHomeUpdate(
      { flakeDir: "/fake/flake", dryRun: false, format: "plain" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(2);
    expect(fx.errs.join("\n")).toContain("flake.nix not found");
    expect(fx.spawnCalls).toEqual([]);
  });

  test("missing flake.lock exits 2", () => {
    const fx = makeFixture({
      revs: [],
      spawnResults: [],
      existingPaths: new Set(["/fake/flake", "/fake/flake/flake.nix"]),
    });

    const exit = runHomeUpdate(
      { flakeDir: "/fake/flake", dryRun: false, format: "plain" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(2);
    expect(fx.errs.join("\n")).toContain("flake.lock not found");
    expect(fx.spawnCalls).toEqual([]);
  });

  test("input not in lock exits 2 and lists available inputs", () => {
    const fx = makeFixture({
      revs: [],
      spawnResults: [],
      inputName: "not-present-placeholder",
      extraNodes: {
        nixpkgs: { locked: { rev: "x" } },
        "home-manager": { locked: { rev: "y" } },
      },
    });

    const exit = runHomeUpdate(
      {
        flakeDir: "/fake/flake",
        input: "nonexistent",
        dryRun: false,
        format: "plain",
      },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(2);
    const err = fx.errs.join("\n");
    expect(err).toContain('input "nonexistent" not found');
    expect(err).toContain("home-manager");
    expect(err).toContain("nixpkgs");
    expect(fx.spawnCalls).toEqual([]);
  });

  test("nix flake update non-zero exit passes through without running switch", () => {
    const fx = makeFixture({
      revs: ["aaaaaaaaaa1111"],
      spawnResults: [{ status: 3 }],
    });

    const exit = runHomeUpdate(
      { flakeDir: "/fake/flake", dryRun: false, format: "plain" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(3);
    expect(fx.spawnCalls).toHaveLength(1);
    expect(fx.spawnCalls[0]!.file).toBe("nix");
    expect(fx.errs.join("\n")).toContain("nix flake update exited with status 3");
  });

  test("home-manager switch non-zero exit passes through (lock stays at new rev)", () => {
    const fx = makeFixture({
      revs: ["aaaaaaaaaa1111", "bbbbbbbbbb2222"],
      spawnResults: [{ status: 0 }, { status: 7 }],
    });

    const exit = runHomeUpdate(
      { flakeDir: "/fake/flake", dryRun: false, format: "plain" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(7);
    expect(fx.spawnCalls).toHaveLength(2);
    expect(fx.errs.join("\n")).toContain("home-manager switch exited with status 7");
  });

  test("spawn error from nix surfaces non-zero without running switch", () => {
    const fx = makeFixture({
      revs: ["aaaaaaaaaa1111"],
      spawnResults: [{ status: null, error: new Error("ENOENT nix") }],
    });

    const exit = runHomeUpdate(
      { flakeDir: "/fake/flake", dryRun: false, format: "plain" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(1);
    expect(fx.spawnCalls).toHaveLength(1);
    expect(fx.errs.join("\n")).toContain("failed to invoke nix");
  });

  test("runCli routes `home update` to the injected homeUpdate handler with parsed flags", () => {
    const calls: Array<{
      flakeDir?: string | undefined;
      input?: string | undefined;
      dryRun: boolean;
      format: "plain" | "json";
    }> = [];

    const logs: string[] = [];
    const errs: string[] = [];
    const exit = runCli(
      [
        "home",
        "update",
        "--flake-dir",
        "/custom/flake",
        "--input",
        "ai-home",
        "--dry-run",
        "--format",
        "json",
      ],
      { log: (l) => logs.push(l), error: (e) => errs.push(e) },
      {
        homeUpdate: (options) => {
          calls.push(options);
          return 0;
        },
      },
    );

    expect(exit).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      flakeDir: "/custom/flake",
      input: "ai-home",
      dryRun: true,
      format: "json",
    });
  });

  test("runCli returns the handler's exit code", () => {
    const exit = runCli(
      ["home", "update"],
      { log: () => {}, error: () => {} },
      { homeUpdate: () => 42 },
    );
    expect(exit).toBe(42);
  });

  test("runCli rejects unknown `home` subcommand with non-zero exit and error message", () => {
    const errs: string[] = [];
    const exit = runCli(
      ["home", "bogus"],
      { log: () => {}, error: (e) => errs.push(e) },
    );
    expect(exit).not.toBe(0);
    expect(errs.join("\n")).toContain("Unknown home subcommand: bogus");
  });

  test("JSON mode pipes child stdio and omits the human banner so stdout stays parseable", () => {
    const fx = makeFixture({
      revs: ["aaaaaaaaaa1111", "bbbbbbbbbb2222"],
      spawnResults: [{ status: 0 }, { status: 0 }],
    });

    const exit = runHomeUpdate(
      { flakeDir: "/fake/flake", dryRun: false, format: "json" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(0);
    expect(fx.spawnCalls.map((c) => c.stdio)).toEqual(["pipe", "pipe"]);
    // Every log line must be part of the final JSON payload — no banner,
    // no `prx home update: ...` prefix interleaved with the payload.
    expect(fx.logs).toHaveLength(1);
    expect(() => JSON.parse(fx.logs[0]!)).not.toThrow();
  });

  test("home-manager switch is invoked with --flake pointing at the validated flake dir", () => {
    const fx = makeFixture({
      revs: ["aaaaaaaaaa1111", "bbbbbbbbbb2222"],
      spawnResults: [{ status: 0 }, { status: 0 }],
    });

    runHomeUpdate(
      { flakeDir: "/fake/flake", dryRun: false, format: "plain" },
      fx.output,
      fx.deps,
    );

    const switchCall = fx.spawnCalls.find((c) => c.file === "home-manager");
    expect(switchCall).toBeDefined();
    expect(switchCall?.args).toEqual(["switch", "--flake", "/fake/flake"]);
  });

  test("JSON success output includes from/to and noop=false", () => {
    const fx = makeFixture({
      revs: ["aaaaaaaaaa1111", "bbbbbbbbbb2222"],
      spawnResults: [{ status: 0 }, { status: 0 }],
    });

    const exit = runHomeUpdate(
      { flakeDir: "/fake/flake", dryRun: false, format: "json" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(0);
    const payload = JSON.parse(fx.logs[fx.logs.length - 1]!);
    expect(payload.flakeDir).toBe("/fake/flake");
    expect(payload.input).toBe("ai-home");
    expect(payload.from).toBe("aaaaaaaaaa1111");
    expect(payload.to).toBe("bbbbbbbbbb2222");
    expect(payload.noop).toBe(false);
    expect(payload.switched).toBe(true);
  });

  test("GH-838: reconcile is invoked post-switch with the prx socket and embedded in JSON", () => {
    const reconcileCalls: Array<{ socket: string; dryRun: boolean }> = [];
    const fx = makeFixture({
      revs: ["aaaaaaaaaa1111", "bbbbbbbbbb2222"],
      spawnResults: [{ status: 0 }, { status: 0 }],
    });
    fx.deps.computeTmuxReconcile = (options) => {
      reconcileCalls.push({ socket: options.socket, dryRun: options.dryRun });
      return {
        result: {
          socket: options.socket,
          serverRunning: true,
          configPath: "/home/test/.config/tmux/tmux.conf",
          checked: 5,
          applied: [
            {
              option: "focus-events",
              scope: "global",
              from: "off",
              to: "on",
              command: "tmux -L prx set -g focus-events on",
              status: "applied",
              exitCode: 0,
            },
          ],
          unsupported: [],
          inSync: false,
          errors: [],
        },
        exitCode: 0,
      };
    };

    const exit = runHomeUpdate(
      { flakeDir: "/fake/flake", dryRun: false, format: "json" },
      fx.output,
      fx.deps,
    );
    expect(exit).toBe(0);
    expect(reconcileCalls).toEqual([{ socket: "prx", dryRun: false }]);
    const payload = JSON.parse(fx.logs[0]!);
    expect(payload.tmuxReconcile.socket).toBe("prx");
    expect(payload.tmuxReconcile.applied[0].option).toBe("focus-events");
    expect(payload.tmuxReconcile.inSync).toBe(false);
  });

  test("GH-838: reconcile dry-run is invoked when home update is dry-run", () => {
    const reconcileCalls: Array<{ socket: string; dryRun: boolean }> = [];
    const fx = makeFixture({
      revs: ["aaaaaaaaaa1111"],
      spawnResults: [],
    });
    fx.deps.computeTmuxReconcile = (options) => {
      reconcileCalls.push({ socket: options.socket, dryRun: options.dryRun });
      return {
        result: {
          socket: options.socket,
          serverRunning: false,
          configPath: "/home/test/.config/tmux/tmux.conf",
          checked: 0,
          applied: [],
          unsupported: [],
          inSync: true,
          errors: [],
        },
        exitCode: 0,
      };
    };
    const exit = runHomeUpdate(
      { flakeDir: "/fake/flake", dryRun: true, format: "plain" },
      fx.output,
      fx.deps,
    );
    expect(exit).toBe(0);
    expect(reconcileCalls).toEqual([{ socket: "prx", dryRun: true }]);
    expect(fx.logs.join("\n")).toContain("prx tmux reconcile (dry-run):");
  });

  test("GH-838: reconcile applied summary appears in plain output after the switch line", () => {
    const fx = makeFixture({
      revs: ["aaaaaaaaaa1111", "bbbbbbbbbb2222"],
      spawnResults: [{ status: 0 }, { status: 0 }],
    });
    fx.deps.computeTmuxReconcile = (options) => ({
      result: {
        socket: options.socket,
        serverRunning: true,
        configPath: "/home/test/.config/tmux/tmux.conf",
        checked: 5,
        applied: [
          {
            option: "focus-events",
            scope: "global",
            from: "off",
            to: "on",
            command: "tmux -L prx set -g focus-events on",
            status: "applied",
            exitCode: 0,
          },
        ],
        unsupported: [],
        inSync: false,
        errors: [],
      },
      exitCode: 0,
    });
    runHomeUpdate(
      { flakeDir: "/fake/flake", dryRun: false, format: "plain" },
      fx.output,
      fx.deps,
    );
    const switchIdx = fx.logs.findIndex((l) => l.includes("home-manager switched"));
    const reconcileIdx = fx.logs.findIndex((l) => l.includes("prx tmux reconcile:"));
    expect(switchIdx).toBeGreaterThanOrEqual(0);
    expect(reconcileIdx).toBeGreaterThan(switchIdx);
  });
});
