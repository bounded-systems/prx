import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  defaultBdSpawn,
  execBd,
  formatBdExecResult,
  resolveBeadsGitHubSyncEnv,
  runBdGithubSyncPullOnly,
  runBdShow,
  runBdUpdateClaim,
  type BdGithubRunner,
  type BdSpawnFn,
} from "@bounded-systems/bd";

describe("execBd", () => {
  test("blocks hard-blocked subcommands", () => {
    for (const cmd of ["close", "delete", "archive", "import", "export"]) {
      const result = execBd({ subcommand: cmd, args: [] }, { HOME: "/tmp" });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`blocked subcommand '${cmd}'`);
    }
  });

  test("blocks unknown subcommands", () => {
    const result = execBd({ subcommand: "destroy", args: [] }, { HOME: "/tmp" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown or disallowed");
  });

  test("enforces policy for state/role", () => {
    // Executor can only ready/list/show/view, not create
    const result = execBd(
      { subcommand: "create", args: [], state: "planning", role: "executor" },
      { HOME: "/tmp" },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("blocked");
    expect(result.policy?.allowed).toBe(false);
  });

  test("planner can create in planning state", () => {
    // This actually calls bd — policy should allow it
    const result = execBd(
      { subcommand: "create", args: ["--help"], state: "planning", role: "planner" },
    );
    expect(result.policy?.allowed).toBe(true);
  });

  test("executor can list in any state", () => {
    const result = execBd(
      { subcommand: "list", args: ["--help"], state: "validating", role: "executor" },
    );
    expect(result.policy?.allowed).toBe(true);
  });

  test("respects env vars for state and role", () => {
    const result = execBd(
      { subcommand: "create", args: [] },
      { PRX_CAPABILITY_STATE: "planning", PRX_AGENT_ROLE: "executor", HOME: "/tmp" },
    );
    expect(result.exitCode).toBe(1);
    expect(result.policy?.state).toBe("planning");
    expect(result.policy?.role).toBe("executor");
  });
});

describe("execBd: bd short-id id-position guard (GH-1473)", () => {
  // A long id whose timestamp segment embeds the short numbers below — exactly
  // the substring overlap bd's prefix resolver fuzzy-matched on.
  const LONG_ID = "ai-home-1777491131463-12-407f177f";

  test("refuses a bare ai-home-<n> short id in id position (before spawn)", () => {
    let spawned = false;
    const fakeSpawn: BdSpawnFn = () => {
      spawned = true;
      return { status: 0, signal: null, stdout: "", stderr: "" };
    };
    const result = execBd(
      {
        subcommand: "update",
        args: ["ai-home-1463", "--status", "closed"],
        state: "planning",
        role: "planner",
      },
      { HOME: "/tmp" },
      fakeSpawn,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("refusing bd short id 'ai-home-1463'");
    expect(result.stderr).toContain("GH-1473");
    expect(result.stderr).toContain("GH-1479");
    expect(result.policy).toBeNull();
    expect(spawned).toBe(false);
  });

  test("refuses the three documented wrong-match short ids (regression)", () => {
    for (const shortId of ["ai-home-1463", "ai-home-1464", "ai-home-1404"]) {
      const result = execBd(
        {
          subcommand: "dep",
          args: ["add", "--type", "blocks", LONG_ID, shortId],
          state: "planning",
          role: "planner",
        },
        { HOME: "/tmp" },
        () => ({ status: 0, signal: null, stdout: "", stderr: "" }),
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`refusing bd short id '${shortId}'`);
    }
  });

  test("admits canonical long ids in id position", () => {
    let recorded: readonly string[] | null = null;
    const fakeSpawn: BdSpawnFn = (cmd) => {
      recorded = cmd;
      return { status: 0, signal: null, stdout: "", stderr: "" };
    };
    const result = execBd(
      {
        subcommand: "dep",
        args: ["add", "--type", "blocks", LONG_ID, "ai-home-1777491131463-99-deadbeef"],
        state: "planning",
        role: "planner",
      },
      { HOME: "/tmp" },
      fakeSpawn,
    );
    expect(result.exitCode).toBe(0);
    expect(recorded).not.toBeNull();
    expect(recorded!.slice(-2)).toEqual([LONG_ID, "ai-home-1777491131463-99-deadbeef"]);
  });

  test("admits --notes free text that merely contains a short-id token", () => {
    let spawned = false;
    const fakeSpawn: BdSpawnFn = () => {
      spawned = true;
      return { status: 0, signal: null, stdout: "", stderr: "" };
    };
    const result = execBd(
      {
        subcommand: "update",
        args: [LONG_ID, "--notes", "see ai-home-1463 for the original miswire"],
        state: "planning",
        role: "planner",
      },
      { HOME: "/tmp" },
      fakeSpawn,
    );
    expect(result.exitCode).toBe(0);
    expect(spawned).toBe(true);
  });

  test("admits a flag value that is exactly a short id (id-position only)", () => {
    const result = execBd(
      {
        subcommand: "update",
        args: [LONG_ID, "--notes", "ai-home-1463"],
        state: "planning",
        role: "planner",
      },
      { HOME: "/tmp" },
      () => ({ status: 0, signal: null, stdout: "", stderr: "" }),
    );
    expect(result.exitCode).toBe(0);
  });
});

describe("execBd `sql` allowlist + --readonly inject (GH-1573)", () => {
  test("planner is allowed `sql`; the wrapper injects --readonly before spawn", () => {
    let recordedCmd: readonly string[] | null = null;
    const fakeSpawn: BdSpawnFn = (cmd) => {
      recordedCmd = cmd;
      return { status: 0, signal: null, stdout: "[]", stderr: "" };
    };

    const result = execBd(
      {
        subcommand: "sql",
        args: ["--json", "SELECT 1"],
        state: "planning",
        role: "planner",
      },
      { HOME: "/tmp" },
      fakeSpawn,
    );

    expect(result.policy?.allowed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(recordedCmd).not.toBeNull();
    // cmd shape: ["bd", subcommand, ...args]. --readonly must immediately
    // follow the subcommand so cobra parses it as the global flag.
    expect(recordedCmd![0]).toBe("bd");
    expect(recordedCmd![1]).toBe("sql");
    expect(recordedCmd![2]).toBe("--readonly");
    expect(recordedCmd!.slice(3)).toEqual(["--json", "SELECT 1"]);
  });

  test("does not duplicate --readonly when the caller already passed it", () => {
    let recordedCmd: readonly string[] | null = null;
    const fakeSpawn: BdSpawnFn = (cmd) => {
      recordedCmd = cmd;
      return { status: 0, signal: null, stdout: "[]", stderr: "" };
    };

    execBd(
      {
        subcommand: "sql",
        args: ["--readonly", "--json", "SELECT 1"],
        state: "planning",
        role: "planner",
      },
      { HOME: "/tmp" },
      fakeSpawn,
    );

    const flags = recordedCmd!.filter((arg) => arg === "--readonly");
    expect(flags).toHaveLength(1);
  });

  test("executor is denied `sql` (planner-only allowlist)", () => {
    const result = execBd(
      { subcommand: "sql", args: ["--json", "SELECT 1"], state: "planning", role: "executor" },
      { HOME: "/tmp" },
    );
    expect(result.exitCode).toBe(1);
    expect(result.policy?.allowed).toBe(false);
    expect(result.stderr).toContain("blocked");
  });
});

describe("execBd: no stdout ceiling + partial-read guard (GH-1554)", () => {
  test(">1 MiB stdout passes through with exit 0 (guard layer)", () => {
    const big = "x".repeat(2 * 1024 * 1024);
    const fakeSpawn: BdSpawnFn = () => ({
      status: 0,
      signal: null,
      stdout: big,
      stderr: "",
    });

    const result = execBd(
      { subcommand: "list", args: [], state: "planning", role: "planner" },
      { HOME: "/tmp" },
      fakeSpawn,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBe(2 * 1024 * 1024);
  });

  test("signal-killed bd → nonzero + bd-safe stderr, not the partial bytes", () => {
    const fakeSpawn: BdSpawnFn = () => ({
      status: null,
      signal: "SIGTERM",
      stdout: '[{"id":"ai-home-g5f6"',
      stderr: "",
    });

    const result = execBd(
      { subcommand: "list", args: [], state: "planning", role: "planner" },
      { HOME: "/tmp" },
      fakeSpawn,
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toStartWith("bd-safe:");
    expect(result.stderr).toContain("SIGTERM");
    expect(result.stdout).not.toContain("ai-home-g5f6");
  });

  test("spawn error (ENOBUFS) → nonzero + bd-safe stderr, no partial stdout", () => {
    const fakeSpawn: BdSpawnFn = () => ({
      status: null,
      signal: null,
      stdout: "",
      stderr: "",
      error: new Error(
        "spawnSync bd ENOBUFS (stdout or stderr buffer reached maxBuffer size limit)",
      ),
    });

    const result = execBd(
      { subcommand: "list", args: [], state: "planning", role: "planner" },
      { HOME: "/tmp" },
      fakeSpawn,
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("bd-safe:");
    expect(result.stderr).toContain("ENOBUFS");
  });

  test("defaultBdSpawn streams a real >1 MiB subprocess stdout (no in-memory cap)", () => {
    const result = defaultBdSpawn(
      ["bun", "-e", 'process.stdout.write("x".repeat(2 * 1024 * 1024))'],
      { env: process.env as Record<string, string> },
    );

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBe(2 * 1024 * 1024);
  });
});

describe("formatBdExecResult", () => {
  test("json format is valid JSON", () => {
    const result = execBd({ subcommand: "close", args: [] }, { HOME: "/tmp" });
    const json = JSON.parse(formatBdExecResult(result, "json"));
    expect(json.exitCode).toBe(1);
    expect(json.stderr).toContain("blocked");
  });
});

describe("resolveBeadsGitHubSyncEnv", () => {
  let savedToken: string | undefined;

  beforeEach(() => {
    savedToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    if (savedToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = savedToken;
    }
  });

  test("returns undefined when GITHUB_TOKEN is already set in parent env", () => {
    process.env.GITHUB_TOKEN = "preset-token";
    let runnerCalls = 0;
    const runner: BdGithubRunner = () => {
      runnerCalls += 1;
      return { stdout: "", stderr: "", status: 0 };
    };

    const result = resolveBeadsGitHubSyncEnv("/tmp", runner);

    expect(result).toBeUndefined();
    expect(runnerCalls).toBe(0); // short-circuits before calling gh
  });

  test("returns merged env (preserves PATH) when falling back to gh auth token (GH-987)", () => {
    // Regression: prior behavior returned { GITHUB_TOKEN: token } only,
    // stripping PATH/HOME so spawned `bd` exited 1 with no stdout.
    const runner: BdGithubRunner = (cmd) => {
      expect(cmd).toEqual(["gh", "auth", "token"]);
      return { stdout: "gh-token-value\n", stderr: "", status: 0 };
    };

    const result = resolveBeadsGitHubSyncEnv("/tmp", runner);

    expect(result).toBeDefined();
    expect(result?.GITHUB_TOKEN).toBe("gh-token-value");
    // The fix: merged env must carry over parent vars `bd` needs.
    expect(result?.PATH).toBe(process.env.PATH);
    // Sanity: at least PATH-or-equivalent + GITHUB_TOKEN, not a single-key object.
    expect(Object.keys(result ?? {}).length).toBeGreaterThan(1);
  });

  test("returns undefined when gh auth token exits non-zero", () => {
    const runner: BdGithubRunner = () => ({ stdout: "", stderr: "not logged in", status: 1 });

    const result = resolveBeadsGitHubSyncEnv("/tmp", runner);

    expect(result).toBeUndefined();
  });

  test("returns undefined when gh auth token returns empty stdout", () => {
    const runner: BdGithubRunner = () => ({ stdout: "   \n", stderr: "", status: 0 });

    const result = resolveBeadsGitHubSyncEnv("/tmp", runner);

    expect(result).toBeUndefined();
  });
});

describe("runBdGithubSyncPullOnly", () => {
  let savedToken: string | undefined;

  beforeEach(() => {
    savedToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    if (savedToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = savedToken;
    }
  });

  test("invokes canonical bd github sync args with merged env (GH-987 regression)", () => {
    const calls: { cmd: string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
    const runner: BdGithubRunner = (cmd, options = {}) => {
      calls.push({ cmd, env: options.env });
      if (cmd[0] === "gh") {
        return { stdout: "gh-token-value\n", stderr: "", status: 0 };
      }
      return { stdout: "✓ Pulled 350 issues (16 created, 334 updated)\n", stderr: "", status: 0 };
    };

    const result = runBdGithubSyncPullOnly("/tmp", {}, runner);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Pulled 350 issues");

    const bdCall = calls.find((c) => c.cmd[0] === "bd");
    expect(bdCall).toBeDefined();
    // Canonical reconcile direction per `feedback_beads_github_authority`.
    expect(bdCall?.cmd).toEqual(["bd", "github", "sync", "--pull-only", "--prefer-github"]);
    // Merged env: GITHUB_TOKEN + parent PATH (regression — would be missing under old behavior).
    expect(bdCall?.env?.GITHUB_TOKEN).toBe("gh-token-value");
    expect(bdCall?.env?.PATH).toBe(process.env.PATH);
  });

  test("appends --dry-run when options.dryRun is true", () => {
    const calls: string[][] = [];
    const runner: BdGithubRunner = (cmd) => {
      calls.push(cmd);
      if (cmd[0] === "gh") return { stdout: "tok\n", stderr: "", status: 0 };
      return { stdout: "", stderr: "", status: 0 };
    };

    runBdGithubSyncPullOnly("/tmp", { dryRun: true }, runner);

    const bdCall = calls.find((c) => c[0] === "bd");
    expect(bdCall).toEqual([
      "bd", "github", "sync", "--pull-only", "--prefer-github", "--dry-run",
    ]);
  });
});

// GH-1766 ----------------------------------------------------------------

describe("runBdShow", () => {
  test("parses a valid bd show payload via the Zod schema", () => {
    const runner: BdGithubRunner = () => ({
      stdout: JSON.stringify({
        id: "ai-home-1777747201085-737-407f177f",
        title: "fixture title",
        description: "fixture body",
        status: "open",
        priority: 1,
        issueType: "task",
        labels: ["bug"],
      }),
      stderr: "",
      status: 0,
    });
    const result = runBdShow("ai-home-1777747201085-737-407f177f", "/tmp", runner);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.id).toBe("ai-home-1777747201085-737-407f177f");
      expect(result.record.title).toBe("fixture title");
      expect(result.record.status).toBe("open");
    }
  });

  test("non-zero exit surfaces as ok=false", () => {
    const runner: BdGithubRunner = () => ({
      stdout: "",
      stderr: "record not found",
      status: 1,
    });
    const result = runBdShow("ai-home-bogus", "/tmp", runner);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("record not found");
    }
  });

  test("garbage stdout surfaces as a schema/parse error rather than a fake success", () => {
    const runner: BdGithubRunner = () => ({
      stdout: "not json at all",
      stderr: "",
      status: 0,
    });
    const result = runBdShow("any", "/tmp", runner);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stderr).toContain("bd show:");
    }
  });

  test("unwraps a length-1 array from bd show --json", () => {
    const runner: BdGithubRunner = () => ({
      stdout: JSON.stringify([
        {
          id: "ai-home-1777747201085-737-407f177f",
          title: "fixture title",
          description: "fixture body",
          status: "open",
          priority: 1,
          issueType: "task",
          labels: ["bug"],
        },
      ]),
      stderr: "",
      status: 0,
    });
    const result = runBdShow("ai-home-1777747201085-737-407f177f", "/tmp", runner);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.id).toBe("ai-home-1777747201085-737-407f177f");
      expect(result.record.title).toBe("fixture title");
      expect(result.record.status).toBe("open");
    }
  });

  test("empty array surfaces as ok=false with no-record error", () => {
    const runner: BdGithubRunner = () => ({
      stdout: "[]",
      stderr: "",
      status: 0,
    });
    const result = runBdShow("ai-home-missing", "/tmp", runner);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stderr).toContain("no record returned for");
      expect(result.stderr).toContain("ai-home-missing");
    }
  });
});

describe("runBdUpdateClaim", () => {
  test("invokes `bd update <id> --claim` and surfaces the exit code", () => {
    const calls: string[][] = [];
    const runner: BdGithubRunner = (cmd) => {
      calls.push(cmd);
      return { stdout: "claimed\n", stderr: "", status: 0 };
    };
    const result = runBdUpdateClaim(
      "ai-home-1777747201085-737-407f177f",
      "/tmp",
      runner,
    );
    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([
      [
        "bd",
        "update",
        "ai-home-1777747201085-737-407f177f",
        "--claim",
      ],
    ]);
  });

  test("propagates non-zero exit codes (caller decides whether to fail)", () => {
    const runner: BdGithubRunner = () => ({
      stdout: "",
      stderr: "already claimed by someone-else",
      status: 2,
    });
    const result = runBdUpdateClaim("ai-home-x", "/tmp", runner);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("already claimed");
  });
});
