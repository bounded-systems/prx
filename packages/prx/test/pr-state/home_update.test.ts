import { describe, expect, test } from "bun:test";

import {
  runHomeUpdate,
  resolveFlakeDir,
  resolveInputNames,
  readConfiguredHomeUpdateInputs,
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
  // prx-9lc: each entry is a flake.lock snapshot (input name -> locked rev),
  // consumed one per readFile call (call 1 = "from", call 2 = "to"). A name
  // omitted from a snapshot is absent from the lock (warn-and-skip path).
  lockStates: Array<Record<string, string>>;
  spawnResults: HomeUpdateSpawnResult[];
  existingPaths?: Set<string>;
  // Unrelated inputs always present in every snapshot (e.g. nixpkgs).
  extraNodes?: Record<string, { locked: { rev: string } }>;
}) {
  const logs: string[] = [];
  const errs: string[] = [];
  const spawnCalls: SpawnCall[] = [];
  const lockStates = [...params.lockStates];
  const spawnResults = [...params.spawnResults];
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
    const state = lockStates.shift() ?? {};
    const nodes: Record<string, { locked: { rev: string } }> = {
      ...(params.extraNodes ?? {}),
    };
    for (const [name, rev] of Object.entries(state)) {
      nodes[name] = { locked: { rev } };
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

describe("resolveInputNames", () => {
  test("flag beats env beats config beats the ['prx'] default (GH-411 slice 3)", () => {
    // flag wins over everything
    expect(
      resolveInputNames(
        { input: "custom", dryRun: false, format: "plain" },
        { PRX_HOME_FLAKE_INPUT: "env-input" },
        ["cfg"],
      ),
    ).toEqual(["custom"]);
    // env wins over config
    expect(
      resolveInputNames(
        { dryRun: false, format: "plain" },
        { PRX_HOME_FLAKE_INPUT: "env-input" },
        ["cfg"],
      ),
    ).toEqual(["env-input"]);
    // config wins over the standalone default
    expect(
      resolveInputNames({ dryRun: false, format: "plain" }, {}, ["prx", "ai-home"]),
    ).toEqual(["prx", "ai-home"]);
    // nothing requested or configured → standalone default ['prx']
    expect(resolveInputNames({ dryRun: false, format: "plain" }, {})).toEqual(["prx"]);
    expect(resolveInputNames({ dryRun: false, format: "plain" }, {}, [])).toEqual(["prx"]);
    expect(resolveInputNames({ dryRun: false, format: "plain" }, {}, null)).toEqual(["prx"]);
  });

  test("prx-9lc: splits a comma-separated list, trims, drops empties", () => {
    expect(
      resolveInputNames({ input: "prx,ai-home", dryRun: false, format: "plain" }, {}),
    ).toEqual(["prx", "ai-home"]);
    expect(
      resolveInputNames(
        { input: " prx , , ai-home ", dryRun: false, format: "plain" },
        {},
      ),
    ).toEqual(["prx", "ai-home"]);
    // An all-empty list falls back to config, then the standalone default.
    expect(
      resolveInputNames({ input: ",,", dryRun: false, format: "plain" }, {}, ["prx", "ai-home"]),
    ).toEqual(["prx", "ai-home"]);
    expect(
      resolveInputNames({ input: ",,", dryRun: false, format: "plain" }, {}),
    ).toEqual(["prx"]);
  });
});

describe("readConfiguredHomeUpdateInputs (GH-411 slice 3)", () => {
  const config = (obj: unknown) => ({
    homeDir: "/home/op",
    pathExists: (p: string) => p === "/home/op/.config/prx/config.json",
    readFile: () => JSON.stringify(obj),
  });

  test("reads homeUpdate.inputs, trims, drops empties", () => {
    expect(
      readConfiguredHomeUpdateInputs(config({ homeUpdate: { inputs: [" prx ", "", "ai-home"] } })),
    ).toEqual(["prx", "ai-home"]);
  });

  test("null when no config file", () => {
    expect(
      readConfiguredHomeUpdateInputs({ homeDir: "/home/op", pathExists: () => false }),
    ).toBeNull();
  });

  test("null when the block / inputs are absent or non-array", () => {
    expect(readConfiguredHomeUpdateInputs(config({}))).toBeNull();
    expect(readConfiguredHomeUpdateInputs(config({ homeUpdate: {} }))).toBeNull();
    expect(readConfiguredHomeUpdateInputs(config({ homeUpdate: { inputs: "prx" } }))).toBeNull();
    expect(readConfiguredHomeUpdateInputs(config({ homeUpdate: { inputs: [] } }))).toBeNull();
  });

  test("null on malformed JSON (never breaks upgrade)", () => {
    expect(
      readConfiguredHomeUpdateInputs({
        homeDir: "/home/op",
        pathExists: () => true,
        readFile: () => "{ not json",
      }),
    ).toBeNull();
  });
});

describe("runHomeUpdate", () => {
  test("happy path: nix flake update → commit flake.lock → home-manager switch (prx-1ab)", () => {
    const fx = makeFixture({
      lockStates: [{ "ai-home": "aaaaaaaaaa1111" }, { "ai-home": "bbbbbbbbbb2222" }],
      // nix update, git rev-parse (is-git), git add, git commit, hm switch.
      spawnResults: [{ status: 0 }, { status: 0 }, { status: 0 }, { status: 0 }, { status: 0 }],
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
    expect(fx.spawnCalls).toHaveLength(5);
    expect(fx.spawnCalls[0]!).toEqual({
      file: "nix",
      args: ["flake", "update", "ai-home", "--flake", "/fake/flake"],
      cwd: "/fake/flake",
      // prx-up2: quiet by default — the heavy commands are captured, not inherited.
      stdio: "pipe",
    });
    // prx-1ab: the lockfile is committed between update and switch so the
    // git+file flake tree is clean — the step that used to be manual.
    expect(fx.spawnCalls[1]!.args).toEqual(["-C", "/fake/flake", "rev-parse", "--git-dir"]);
    expect(fx.spawnCalls[2]!.args).toEqual(["-C", "/fake/flake", "add", "flake.lock"]);
    expect(fx.spawnCalls[3]!.file).toBe("git");
    expect(fx.spawnCalls[3]!.args.slice(0, 3)).toEqual(["-C", "/fake/flake", "commit"]);
    expect(fx.spawnCalls[4]).toEqual({
      file: "home-manager",
      args: ["switch", "--flake", "/fake/flake"],
      cwd: "/fake/flake",
      stdio: "pipe",
    });
    const log = fx.logs.join("\n");
    expect(log).toContain("ai-home: aaaaaaa → bbbbbbb");
    expect(log).toContain("home-manager switched");
    expect(fx.errs).toEqual([]);
  });

  test("prx-9lc: multi-input updates both inputs in one nix flake update and commits both moved", () => {
    const fx = makeFixture({
      lockStates: [
        { prx: "prx1111aaaa", "ai-home": "aih1111bbbb" },
        { prx: "prx2222cccc", "ai-home": "aih2222dddd" },
      ],
      spawnResults: [{ status: 0 }, { status: 0 }, { status: 0 }, { status: 0 }, { status: 0 }],
    });

    const exit = runHomeUpdate(
      { flakeDir: "/fake/flake", input: "prx,ai-home", dryRun: false, format: "plain" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(0);
    // One nix invocation names both inputs (scoped — does not touch nixpkgs).
    expect(fx.spawnCalls[0]!.args).toEqual([
      "flake",
      "update",
      "prx",
      "ai-home",
      "--flake",
      "/fake/flake",
    ]);
    // Commit message names both moved inputs with their rev transitions.
    const commit = fx.spawnCalls.find(
      (c) => c.file === "git" && c.args.includes("commit"),
    )!;
    const msg = commit.args[commit.args.length - 1]!;
    expect(msg).toContain("prx prx1111→prx2222");
    expect(msg).toContain("ai-home aih1111→aih2222");
    const log = fx.logs.join("\n");
    expect(log).toContain("prx: prx1111 → prx2222");
    expect(log).toContain("ai-home: aih1111 → aih2222");
  });

  test("prx-9lc: when only one of the pair moves, the commit names only the moved input", () => {
    const fx = makeFixture({
      lockStates: [
        { prx: "prxsame0000", "ai-home": "aih1111bbbb" },
        { prx: "prxsame0000", "ai-home": "aih2222dddd" },
      ],
      spawnResults: [{ status: 0 }, { status: 0 }, { status: 0 }, { status: 0 }, { status: 0 }],
    });

    const exit = runHomeUpdate(
      { flakeDir: "/fake/flake", input: "prx,ai-home", dryRun: false, format: "plain" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(0);
    const commit = fx.spawnCalls.find(
      (c) => c.file === "git" && c.args.includes("commit"),
    )!;
    const msg = commit.args[commit.args.length - 1]!;
    expect(msg).toContain("ai-home aih1111→aih2222");
    // prx (unchanged) is absent from the commit message.
    expect(msg).not.toContain("prx ");
    const log = fx.logs.join("\n");
    expect(log).toContain("prx: already up to date (prxsame)");
    expect(log).toContain("ai-home: aih1111 → aih2222");
  });

  test("prx-9lc: an absent input is warned-and-skipped while present inputs still update", () => {
    const fx = makeFixture({
      lockStates: [{ prx: "prx1111aaaa" }, { prx: "prx2222cccc" }],
      extraNodes: { nixpkgs: { locked: { rev: "n" } } },
      spawnResults: [{ status: 0 }, { status: 0 }, { status: 0 }, { status: 0 }, { status: 0 }],
    });

    const exit = runHomeUpdate(
      { flakeDir: "/fake/flake", input: "prx,ai-home", dryRun: false, format: "plain" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(0);
    const err = fx.errs.join("\n");
    expect(err).toContain('input "ai-home" not found');
    expect(err).toContain("skipping");
    // nix flake update names only the present input.
    expect(fx.spawnCalls[0]!.args).toEqual([
      "flake",
      "update",
      "prx",
      "--flake",
      "/fake/flake",
    ]);
    expect(fx.logs.join("\n")).toContain("prx: prx1111 → prx2222");
  });

  test("prx-up2: quiet mode prints per-step progress, --verbose streams the raw log", () => {
    const quiet = makeFixture({
      lockStates: [{ "ai-home": "aaaaaaaaaa1111" }, { "ai-home": "bbbbbbbbbb2222" }],
      spawnResults: [{ status: 0 }, { status: 0 }, { status: 0 }, { status: 0 }, { status: 0 }],
    });
    runHomeUpdate(
      { flakeDir: "/fake/flake", input: "ai-home", dryRun: false, format: "plain" },
      quiet.output,
      quiet.deps,
    );
    const quietLog = quiet.logs.join("\n");
    expect(quietLog).toContain("updating flake input ai-home…");
    expect(quietLog).toContain("switching home-manager generation…");

    const verbose = makeFixture({
      lockStates: [{ "ai-home": "aaaaaaaaaa1111" }, { "ai-home": "bbbbbbbbbb2222" }],
      spawnResults: [{ status: 0 }, { status: 0 }, { status: 0 }, { status: 0 }, { status: 0 }],
    });
    runHomeUpdate(
      { flakeDir: "/fake/flake", input: "ai-home", dryRun: false, format: "plain", verbose: true },
      verbose.output,
      verbose.deps,
    );
    // --verbose inherits the terminal for the heavy steps (no per-step banner).
    expect(verbose.spawnCalls[0]!.stdio).toBe("inherit");
    expect(verbose.spawnCalls[4]!.stdio).toBe("inherit");
    expect(verbose.logs.join("\n")).not.toContain("switching home-manager generation…");
  });

  test("prx-9lc: multi-input quiet progress pluralizes the input list", () => {
    const fx = makeFixture({
      lockStates: [
        { prx: "prx1111aaaa", "ai-home": "aih1111bbbb" },
        { prx: "prx2222cccc", "ai-home": "aih2222dddd" },
      ],
      spawnResults: [{ status: 0 }, { status: 0 }, { status: 0 }, { status: 0 }, { status: 0 }],
    });
    runHomeUpdate(
      { flakeDir: "/fake/flake", input: "prx,ai-home", dryRun: false, format: "plain" },
      fx.output,
      fx.deps,
    );
    expect(fx.logs.join("\n")).toContain("updating flake inputs prx, ai-home…");
  });

  test("prx-up2: a failed switch dumps the captured log so quiet mode stays debuggable", () => {
    const fx = makeFixture({
      lockStates: [{ "ai-home": "aaaaaaaaaa1111" }, { "ai-home": "bbbbbbbbbb2222" }],
      // update ok, rev-parse ok, add ok, commit ok, switch fails with output.
      spawnResults: [
        { status: 0 },
        { status: 0 },
        { status: 0 },
        { status: 0 },
        { status: 1, stderr: "error: build of '/nix/store/x' failed\nsome detail" },
      ],
    });
    const exit = runHomeUpdate(
      { flakeDir: "/fake/flake", input: "ai-home", dryRun: false, format: "plain" },
      fx.output,
      fx.deps,
    );
    expect(exit).toBe(1);
    const errText = fx.errs.join("\n");
    expect(errText).toContain("home-manager switch exited with status 1");
    expect(errText).toContain("captured output");
    expect(errText).toContain("build of '/nix/store/x' failed");
  });

  test("detects no-op when rev unchanged", () => {
    const fx = makeFixture({
      lockStates: [{ "ai-home": "same1234567890" }, { "ai-home": "same1234567890" }],
      spawnResults: [{ status: 0 }, { status: 0 }],
    });

    const exit = runHomeUpdate(
      { flakeDir: "/fake/flake", input: "ai-home", dryRun: false, format: "plain" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(0);
    const log = fx.logs.join("\n");
    expect(log).toContain("ai-home: already up to date (same123)");
    // No readlink dep wired → generation unknown → falls back to prior wording.
    expect(log).toContain("home-manager switched (no input moved)");
    // No git calls fire on a no-op — only nix update + hm switch.
    expect(fx.spawnCalls).toHaveLength(2);
    expect(fx.spawnCalls.some((c) => c.file === "git")).toBe(false);
  });

  test("switch summary names the generation when an input moved (genBefore != genAfter)", () => {
    const fx = makeFixture({
      lockStates: [{ "ai-home": "aaaaaaaaaa1111" }, { "ai-home": "bbbbbbbbbb2222" }],
      spawnResults: [{ status: 0 }, { status: 0 }, { status: 0 }, { status: 0 }, { status: 0 }],
    });
    // Generation moves from 41 → 42 across the switch.
    const targets = ["home-manager-41-link", "home-manager-42-link"];
    fx.deps.readlink = () => targets.shift() ?? null;

    const exit = runHomeUpdate(
      { flakeDir: "/fake/flake", input: "ai-home", dryRun: false, format: "plain" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(0);
    const log = fx.logs.join("\n");
    expect(log).toContain("ai-home: aaaaaaa → bbbbbbb");
    expect(log).toContain("home-manager switched → generation 42");
  });

  test("switch summary reports already-current with generation on a no-op", () => {
    const fx = makeFixture({
      lockStates: [{ "ai-home": "same1234567890" }, { "ai-home": "same1234567890" }],
      spawnResults: [{ status: 0 }, { status: 0 }],
    });
    // Generation unchanged across the switch (no input moved).
    fx.deps.readlink = () => "home-manager-42-link";

    const exit = runHomeUpdate(
      { flakeDir: "/fake/flake", input: "ai-home", dryRun: false, format: "plain" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(0);
    const log = fx.logs.join("\n");
    expect(log).toContain("ai-home: already up to date (same123)");
    expect(log).toContain("home-manager already current (generation 42)");
  });

  test("switch summary reports unchanged generation when an input moved but generation held", () => {
    const fx = makeFixture({
      lockStates: [{ "ai-home": "aaaaaaaaaa1111" }, { "ai-home": "bbbbbbbbbb2222" }],
      spawnResults: [{ status: 0 }, { status: 0 }, { status: 0 }, { status: 0 }, { status: 0 }],
    });
    // Same generation before and after even though the rev moved.
    fx.deps.readlink = () => "home-manager-42-link";

    const exit = runHomeUpdate(
      { flakeDir: "/fake/flake", input: "ai-home", dryRun: false, format: "plain" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(0);
    expect(fx.logs.join("\n")).toContain("home-manager switched (generation 42, unchanged)");
  });

  test("switch summary falls back to prior wording when the generation can't be read", () => {
    const fx = makeFixture({
      lockStates: [{ "ai-home": "aaaaaaaaaa1111" }, { "ai-home": "bbbbbbbbbb2222" }],
      spawnResults: [{ status: 0 }, { status: 0 }, { status: 0 }, { status: 0 }, { status: 0 }],
    });
    // readlink fails / unreadable → generation unknown.
    fx.deps.readlink = () => null;

    const exit = runHomeUpdate(
      { flakeDir: "/fake/flake", input: "ai-home", dryRun: false, format: "plain" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(0);
    const log = fx.logs.join("\n");
    expect(log).toContain("home-manager switched");
    // Fallback summary carries no generation number (the bare "switching
    // home-manager generation…" progress line is unrelated).
    expect(log).not.toContain("→ generation");
    expect(log).not.toContain("(generation");
  });

  test("dry-run prints commands but does not spawn", () => {
    const fx = makeFixture({
      lockStates: [{ "ai-home": "aaaaaaaaaa1111" }],
      spawnResults: [],
    });

    const exit = runHomeUpdate(
      { flakeDir: "/fake/flake", input: "ai-home", dryRun: true, format: "plain" },
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

  test("dry-run JSON payload includes inputs[] from rev and command arrays", () => {
    const fx = makeFixture({
      lockStates: [{ "ai-home": "aaaaaaaaaa1111" }],
      spawnResults: [],
    });

    const exit = runHomeUpdate(
      { flakeDir: "/fake/flake", input: "ai-home", dryRun: true, format: "json" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(0);
    const parsed = JSON.parse(fx.logs[0]!);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.flakeDir).toBe("/fake/flake");
    expect(parsed.inputs).toEqual([{ name: "ai-home", from: "aaaaaaaaaa1111" }]);
    expect(parsed.commands[0]).toEqual([
      "nix",
      "flake",
      "update",
      "ai-home",
      "--flake",
      "/fake/flake",
    ]);
    // prx-1ab: the lockfile commit is previewed between update and switch.
    expect(parsed.commands[1]).toEqual([
      "git",
      "-C",
      "/fake/flake",
      "commit",
      "flake.lock",
      "-m",
      "chore(flake): update ai-home",
    ]);
    expect(parsed.commands[2]).toEqual([
      "home-manager",
      "switch",
      "--flake",
      "/fake/flake",
    ]);
  });

  test("prx-9lc: dry-run previews a nix flake update listing both inputs", () => {
    const fx = makeFixture({
      lockStates: [{ prx: "prx1111aaaa", "ai-home": "aih1111bbbb" }],
      spawnResults: [],
    });

    const exit = runHomeUpdate(
      { flakeDir: "/fake/flake", input: "prx,ai-home", dryRun: true, format: "json" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(0);
    const parsed = JSON.parse(fx.logs[0]!);
    expect(parsed.commands[0]).toEqual([
      "nix",
      "flake",
      "update",
      "prx",
      "ai-home",
      "--flake",
      "/fake/flake",
    ]);
    expect(parsed.inputs).toEqual([
      { name: "prx", from: "prx1111aaaa" },
      { name: "ai-home", from: "aih1111bbbb" },
    ]);
  });

  test("missing flake dir exits 2", () => {
    const fx = makeFixture({
      lockStates: [],
      spawnResults: [],
      existingPaths: new Set(),
    });

    const exit = runHomeUpdate(
      { flakeDir: "/fake/flake", input: "ai-home", dryRun: false, format: "plain" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(2);
    expect(fx.errs.join("\n")).toContain("flake dir does not exist");
    expect(fx.spawnCalls).toEqual([]);
  });

  test("missing flake.nix exits 2", () => {
    const fx = makeFixture({
      lockStates: [],
      spawnResults: [],
      existingPaths: new Set(["/fake/flake"]),
    });

    const exit = runHomeUpdate(
      { flakeDir: "/fake/flake", input: "ai-home", dryRun: false, format: "plain" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(2);
    expect(fx.errs.join("\n")).toContain("flake.nix not found");
    expect(fx.spawnCalls).toEqual([]);
  });

  test("missing flake.lock exits 2", () => {
    const fx = makeFixture({
      lockStates: [],
      spawnResults: [],
      existingPaths: new Set(["/fake/flake", "/fake/flake/flake.nix"]),
    });

    const exit = runHomeUpdate(
      { flakeDir: "/fake/flake", input: "ai-home", dryRun: false, format: "plain" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(2);
    expect(fx.errs.join("\n")).toContain("flake.lock not found");
    expect(fx.spawnCalls).toEqual([]);
  });

  test("none of the requested inputs present exits 2 and lists available inputs", () => {
    const fx = makeFixture({
      lockStates: [{}],
      spawnResults: [],
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
    expect(err).toContain("none of the requested inputs are present");
    expect(err).toContain("home-manager");
    expect(err).toContain("nixpkgs");
    expect(fx.spawnCalls).toEqual([]);
  });

  test("nix flake update non-zero exit passes through without running switch", () => {
    const fx = makeFixture({
      lockStates: [{ "ai-home": "aaaaaaaaaa1111" }],
      spawnResults: [{ status: 3 }],
    });

    const exit = runHomeUpdate(
      { flakeDir: "/fake/flake", input: "ai-home", dryRun: false, format: "plain" },
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
      lockStates: [{ "ai-home": "aaaaaaaaaa1111" }, { "ai-home": "bbbbbbbbbb2222" }],
      // nix, git rev-parse, git add, git commit (all ok), then switch fails.
      spawnResults: [{ status: 0 }, { status: 0 }, { status: 0 }, { status: 0 }, { status: 7 }],
    });

    const exit = runHomeUpdate(
      { flakeDir: "/fake/flake", input: "ai-home", dryRun: false, format: "plain" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(7);
    expect(fx.spawnCalls).toHaveLength(5);
    expect(fx.errs.join("\n")).toContain("home-manager switch exited with status 7");
  });

  test("spawn error from nix surfaces non-zero without running switch", () => {
    const fx = makeFixture({
      lockStates: [{ "ai-home": "aaaaaaaaaa1111" }],
      spawnResults: [{ status: null, error: new Error("ENOENT nix") }],
    });

    const exit = runHomeUpdate(
      { flakeDir: "/fake/flake", input: "ai-home", dryRun: false, format: "plain" },
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
      verbose?: boolean;
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
        "prx,ai-home",
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
    // The comma-separated value threads through verbatim; the split happens
    // downstream in resolveInputNames.
    expect(calls[0]).toEqual({
      flakeDir: "/custom/flake",
      input: "prx,ai-home",
      dryRun: true,
      format: "json",
      verbose: false,
    });
  });

  test("runCli threads --verbose through to the homeUpdate handler", () => {
    const calls: Array<{ verbose?: boolean }> = [];
    const exit = runCli(
      ["home", "update", "--verbose"],
      { log: () => {}, error: () => {} },
      {
        homeUpdate: (options) => {
          calls.push(options);
          return 0;
        },
      },
    );
    expect(exit).toBe(0);
    expect(calls[0]?.verbose).toBe(true);
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
      lockStates: [{ "ai-home": "aaaaaaaaaa1111" }, { "ai-home": "bbbbbbbbbb2222" }],
      spawnResults: [{ status: 0 }, { status: 0 }],
    });

    const exit = runHomeUpdate(
      { flakeDir: "/fake/flake", input: "ai-home", dryRun: false, format: "json" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(0);
    // prx-1ab: nix, git rev-parse, git add, git commit, hm switch — all piped in
    // JSON mode so stdout stays a single parseable payload.
    expect(fx.spawnCalls.map((c) => c.stdio)).toEqual(["pipe", "pipe", "pipe", "pipe", "pipe"]);
    // Every log line must be part of the final JSON payload — no banner,
    // no `prx home update: ...` prefix interleaved with the payload.
    expect(fx.logs).toHaveLength(1);
    expect(() => JSON.parse(fx.logs[0]!)).not.toThrow();
  });

  test("home-manager switch is invoked with --flake pointing at the validated flake dir", () => {
    const fx = makeFixture({
      lockStates: [{ "ai-home": "aaaaaaaaaa1111" }, { "ai-home": "bbbbbbbbbb2222" }],
      spawnResults: [{ status: 0 }, { status: 0 }],
    });

    runHomeUpdate(
      { flakeDir: "/fake/flake", input: "ai-home", dryRun: false, format: "plain" },
      fx.output,
      fx.deps,
    );

    const switchCall = fx.spawnCalls.find((c) => c.file === "home-manager");
    expect(switchCall).toBeDefined();
    expect(switchCall?.args).toEqual(["switch", "--flake", "/fake/flake"]);
  });

  test("JSON success output emits inputs[] with from/to/noop=false", () => {
    const fx = makeFixture({
      lockStates: [{ "ai-home": "aaaaaaaaaa1111" }, { "ai-home": "bbbbbbbbbb2222" }],
      spawnResults: [{ status: 0 }, { status: 0 }],
    });

    const exit = runHomeUpdate(
      { flakeDir: "/fake/flake", input: "ai-home", dryRun: false, format: "json" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(0);
    const payload = JSON.parse(fx.logs[fx.logs.length - 1]!);
    expect(payload.flakeDir).toBe("/fake/flake");
    expect(payload.inputs).toEqual([
      {
        name: "ai-home",
        from: "aaaaaaaaaa1111",
        to: "bbbbbbbbbb2222",
        noop: false,
      },
    ]);
    expect(payload.switched).toBe(true);
  });

  test("prx-9lc: JSON success emits an inputs[] array with per-input from/to/noop", () => {
    const fx = makeFixture({
      lockStates: [
        { prx: "prxsame0000", "ai-home": "aih1111bbbb" },
        { prx: "prxsame0000", "ai-home": "aih2222dddd" },
      ],
      spawnResults: [],
    });

    const exit = runHomeUpdate(
      { flakeDir: "/fake/flake", input: "prx,ai-home", dryRun: false, format: "json" },
      fx.output,
      fx.deps,
    );

    expect(exit).toBe(0);
    const payload = JSON.parse(fx.logs[fx.logs.length - 1]!);
    expect(payload.inputs).toEqual([
      { name: "prx", from: "prxsame0000", to: "prxsame0000", noop: true },
      { name: "ai-home", from: "aih1111bbbb", to: "aih2222dddd", noop: false },
    ]);
  });
});
