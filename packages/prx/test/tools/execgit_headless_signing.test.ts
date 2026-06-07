/**
 * GH-388: execGit must commit headless-safe — disabling git's gpg/ssh signing —
 * so an operator's interactive signer (e.g. 1Password SSH) can't break a
 * non-interactive/agent commit (the pilot executor's path, and keeper). Lives in
 * the prx test suite (not packages/git) because it needs node fs/child_process to
 * build a fixture repo, which the git package's extractability allowlist forbids.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { execGit } from "@bounded-systems/git";

describe("execGit headless-safe signing (GH-388)", () => {
  test("commit succeeds despite repo-local commit.gpgsign + a bogus signer", () => {
    const dir = mkdtempSync(join(tmpdir(), "execgit-sign-"));
    const cfg = (k: string, v: string) => spawnSync("git", ["-C", dir, "config", k, v]);
    spawnSync("git", ["-C", dir, "init", "-b", "main"]);
    cfg("user.name", "t");
    cfg("user.email", "t@t");
    // A plain `git commit` here would try to sign with a key that doesn't exist
    // and fail ("failed to write commit object").
    cfg("commit.gpgsign", "true");
    cfg("gpg.format", "ssh");
    cfg("user.signingkey", join(dir, "nonexistent-key.pub"));
    writeFileSync(join(dir, "a.txt"), "hi");

    execGit({ subcommand: "add", args: ["a.txt"], cwd: dir, role: "keeper" }, { HOME: dir });
    const res = execGit({ subcommand: "commit", args: ["-m", "x"], cwd: dir, role: "keeper" }, { HOME: dir });

    // execGit injects `-c commit.gpgsign=false`, overriding the repo-local true.
    expect(res.exitCode).toBe(0);
  });
});
