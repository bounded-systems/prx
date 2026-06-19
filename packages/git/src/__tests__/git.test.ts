import { describe, expect, test } from "bun:test";
import { execGit, formatGitExecResult } from "@bounded-systems/git";

describe("execGit", () => {
  test("blocks hard-blocked subcommands", () => {
    const result = execGit({ subcommand: "reset", args: ["--hard"] }, { HOME: "/tmp" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("blocked subcommand 'reset'");
  });

  test("blocks unknown subcommands", () => {
    const result = execGit({ subcommand: "bisect", args: [] }, { HOME: "/tmp" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown or disallowed");
  });

  test("enforces policy for state/role", () => {
    const result = execGit(
      { subcommand: "add", args: ["."], state: "planning", role: "planner" },
      { HOME: "/tmp" },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("blocked");
    expect(result.policy?.allowed).toBe(false);
  });

  test("allows git status for any state/role", () => {
    // This actually runs git — skip if not in a repo
    const result = execGit({
      subcommand: "status",
      args: ["--porcelain"],
      state: "planning",
      role: "planner",
    });
    // Policy should allow it
    expect(result.policy?.allowed).toBe(true);
  });

  test("respects env vars for state and role", () => {
    const result = execGit(
      { subcommand: "add", args: ["."] },
      { PRX_CAPABILITY_STATE: "planning", PRX_AGENT_ROLE: "planner", HOME: "/tmp" },
    );
    expect(result.exitCode).toBe(1);
    expect(result.policy?.state).toBe("planning");
    expect(result.policy?.role).toBe("planner");
  });
});

describe("execGit: partial-read guard (GH-1609)", () => {
  test("git failure surfaces git-safe: prefixed stderr (real spawn path)", () => {
    // `git log` against an empty / non-git directory exits non-zero. The
    // GH-1554-style guard should wipe stdout and prefix stderr with
    // `git-safe:` so a partial / failed run cannot masquerade as a payload.
    const result = execGit({
      subcommand: "log",
      args: [],
      cwd: "/",
      state: "planning",
      role: "planner",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toStartWith("git-safe:");
  });
});

describe("formatGitExecResult", () => {
  test("json format is valid JSON", () => {
    const result = execGit({ subcommand: "reset", args: [] }, { HOME: "/tmp" });
    const json = JSON.parse(formatGitExecResult(result, "json"));
    expect(json.exitCode).toBe(1);
    expect(json.stderr).toContain("blocked");
  });
});
