import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runHook } from "../../src/tools/run_hook.ts";
import type { CommandRunner } from "../../src/pr-state/github.ts";

type Fixture = {
  root: string;
  work: string;
  excludePath: string;
  overlayRoot: string;
  overrideDir: string;
  overridePath: string;
  sentinelPath: string;
};

const OWNER = "bdelanghe";
const REPO = "ai-home";
const ORIGIN_URL = `git@github.com:${OWNER}/${REPO}.git`;

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "prx-run-hook-"));
  const work = join(root, "work");
  spawnSync("git", ["init", "--initial-branch=main", work], { encoding: "utf8" });
  // Add an origin so the dispatcher can resolve reverseDnsRepoSegments.
  spawnSync("git", ["-C", work, "remote", "add", "origin", ORIGIN_URL], {
    encoding: "utf8",
  });

  const overlayRoot = join(root, "ai-home");
  const overrideDir = join(overlayRoot, ".prx", "repos", "io.github", OWNER, REPO, "hooks");
  const overridePath = join(overrideDir, "ensure-prx-excludes");
  const sentinelPath = join(root, "sentinel.txt");

  return {
    root,
    work,
    excludePath: join(work, ".git", "info", "exclude"),
    overlayRoot,
    overrideDir,
    overridePath,
    sentinelPath,
  };
}

let fx: Fixture;
beforeEach(() => {
  fx = makeFixture();
});
afterEach(() => {
  rmSync(fx.root, { recursive: true, force: true });
});

describe("runHook", () => {
  test("not in a git repo → skipped, exitCode 0", () => {
    // bun test preload (test/preload.ts) rewrites TMPDIR to a path inside
    // this very repo, so `git rev-parse --show-toplevel` from any tmpdir
    // resolves to the repo root. Inject a runner that fails the rev-parse
    // call to simulate a true "outside any repo" cwd.
    const failingRevParse: CommandRunner = (cmd) => {
      if (cmd[0] === "git" && cmd[1] === "rev-parse") {
        return { stdout: "", stderr: "fatal: not a git repository", status: 128 };
      }
      throw new Error(`unexpected runner call: ${cmd.join(" ")}`);
    };
    const result = runHook({
      event: "ensure-prx-excludes",
      cwd: fx.root,
      runner: failingRevParse,
      overlayRoot: fx.overlayRoot,
    });
    expect(result.source).toBe("skipped");
    expect(result.reason).toBe("no-repo");
    expect(result.exitCode).toBe(0);
  });

  test("built-in fires when no override exists", () => {
    const result = runHook({
      event: "ensure-prx-excludes",
      cwd: fx.work,
      overlayRoot: fx.overlayRoot, // exists, but no override file in it
    });
    expect(result.source).toBe("builtin");
    expect(result.exitCode).toBe(0);
    expect(result.builtin?.name).toBe("ensure-prx-excludes");
    expect(existsSync(fx.excludePath)).toBe(true);
    const lines = readFileSync(fx.excludePath, "utf8").split(/\r?\n/);
    // Default workspaceTrack = true (no prx.toml), so only `.pr/`.
    expect(lines).toContain(".pr/");
    expect(lines).not.toContain(".prx/");
  });

  test("per-repo override is preferred when present and executable", () => {
    mkdirSync(fx.overrideDir, { recursive: true });
    writeFileSync(
      fx.overridePath,
      `#!/bin/sh\necho "from-override" > "${fx.sentinelPath}"\nexit 0\n`,
    );
    chmodSync(fx.overridePath, 0o755);

    const result = runHook({
      event: "ensure-prx-excludes",
      cwd: fx.work,
      overlayRoot: fx.overlayRoot,
    });
    expect(result.source).toBe("override");
    expect(result.overridePath).toBe(fx.overridePath);
    expect(result.exitCode).toBe(0);

    expect(existsSync(fx.sentinelPath)).toBe(true);
    expect(readFileSync(fx.sentinelPath, "utf8").trim()).toBe("from-override");

    // Built-in must NOT have run. `git init` writes a default info/exclude
    // template, so check that the template was not appended to (no `.pr/`).
    const lines = readFileSync(fx.excludePath, "utf8").split(/\r?\n/);
    expect(lines).not.toContain(".pr/");
    expect(lines).not.toContain(".prx/");
  });

  test("override path resolves correctly via reverseDnsRepoSegments", () => {
    mkdirSync(fx.overrideDir, { recursive: true });
    writeFileSync(fx.overridePath, "#!/bin/sh\nexit 0\n");
    chmodSync(fx.overridePath, 0o755);

    const result = runHook({
      event: "ensure-prx-excludes",
      cwd: fx.work,
      overlayRoot: fx.overlayRoot,
    });
    expect(result.overridePath).toBe(
      join(
        fx.overlayRoot,
        ".prx",
        "repos",
        "io.github",
        OWNER,
        REPO,
        "hooks",
        "ensure-prx-excludes",
      ),
    );
  });

  test("override exists but is not executable → falls back to built-in", () => {
    mkdirSync(fx.overrideDir, { recursive: true });
    writeFileSync(fx.overridePath, "#!/bin/sh\nexit 0\n");
    chmodSync(fx.overridePath, 0o644); // not +x

    const result = runHook({
      event: "ensure-prx-excludes",
      cwd: fx.work,
      overlayRoot: fx.overlayRoot,
    });
    expect(result.source).toBe("skipped");
    expect(result.reason).toBe("override-not-executable");
    expect(result.overridePath).toBe(fx.overridePath);
    expect(result.exitCode).toBe(0);
    // Built-in did not run because the override was found-but-skipped —
    // verify by checking the info/exclude template was not appended.
    const lines = readFileSync(fx.excludePath, "utf8").split(/\r?\n/);
    expect(lines).not.toContain(".pr/");
  });

  test("unknown event with no override → skipped, exitCode 0", () => {
    const result = runHook({
      event: "does-not-exist",
      cwd: fx.work,
      overlayRoot: fx.overlayRoot,
    });
    expect(result.source).toBe("skipped");
    expect(result.reason).toBe("unknown-event");
    expect(result.exitCode).toBe(0);
  });

  test("override non-zero exit propagates via result.exitCode (GH-1124 strict path)", () => {
    // Use an arbitrary event name so we exercise the override branch
    // without fighting the ensure-prx-excludes built-in.
    const overridePath = join(fx.overrideDir, "pre-commit");
    mkdirSync(fx.overrideDir, { recursive: true });
    writeFileSync(overridePath, "#!/bin/sh\nexit 7\n");
    chmodSync(overridePath, 0o755);

    const result = runHook({
      event: "pre-commit",
      cwd: fx.work,
      overlayRoot: fx.overlayRoot,
    });
    expect(result.source).toBe("override");
    expect(result.overridePath).toBe(overridePath);
    expect(result.exitCode).toBe(7);
  });

  test("missing overlayRoot → built-in fires (no override possible)", () => {
    const result = runHook({
      event: "ensure-prx-excludes",
      cwd: fx.work,
      overlayRoot: null,
    });
    expect(result.source).toBe("builtin");
    expect(result.exitCode).toBe(0);
    expect(existsSync(fx.excludePath)).toBe(true);
  });

  test("ensure-claude-settings: built-in stamps from canonical when present", () => {
    const sourceDir = join(fx.overlayRoot, "claude");
    mkdirSync(sourceDir, { recursive: true });
    const canonical = `{"permissions":{"allow":["Read(**)"],"deny":[]}}\n`;
    writeFileSync(join(sourceDir, "worktree-settings.json"), canonical);

    const result = runHook({
      event: "ensure-claude-settings",
      cwd: fx.work,
      overlayRoot: fx.overlayRoot,
    });
    expect(result.source).toBe("builtin");
    expect(result.exitCode).toBe(0);
    expect(result.builtin?.name).toBe("ensure-claude-settings");

    const targetPath = join(fx.work, ".claude", "settings.json");
    expect(existsSync(targetPath)).toBe(true);
    expect(readFileSync(targetPath, "utf8")).toBe(canonical);
  });

  test("ensure-claude-settings: per-repo override is preferred when present", () => {
    const sourceDir = join(fx.overlayRoot, "claude");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      join(sourceDir, "worktree-settings.json"),
      `{"permissions":{"allow":[],"deny":[]}}\n`,
    );

    mkdirSync(fx.overrideDir, { recursive: true });
    const overridePath = join(fx.overrideDir, "ensure-claude-settings");
    writeFileSync(
      overridePath,
      `#!/bin/sh\necho "from-override" > "${fx.sentinelPath}"\nexit 0\n`,
    );
    chmodSync(overridePath, 0o755);

    const result = runHook({
      event: "ensure-claude-settings",
      cwd: fx.work,
      overlayRoot: fx.overlayRoot,
    });
    expect(result.source).toBe("override");
    expect(result.overridePath).toBe(overridePath);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(fx.sentinelPath, "utf8").trim()).toBe("from-override");
    // Built-in must NOT have run.
    expect(existsSync(join(fx.work, ".claude", "settings.json"))).toBe(false);
  });

  test("ensure-claude-settings: missing canonical → no-source, exitCode 0", () => {
    const result = runHook({
      event: "ensure-claude-settings",
      cwd: fx.work,
      overlayRoot: fx.overlayRoot, // exists, but no claude/worktree-settings.json
    });
    expect(result.source).toBe("builtin");
    expect(result.exitCode).toBe(0);
    expect(
      (result.builtin?.details as { reason: string } | undefined)?.reason,
    ).toBe("no-source");
    expect(existsSync(join(fx.work, ".claude", "settings.json"))).toBe(false);
  });
});
