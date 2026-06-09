import { describe, expect, test } from "bun:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const monoRoot = resolve(repoRoot, "..", "..");

function run(cmd: string[]) {
  return Bun.spawnSync({
    cmd,
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function runWithEnv(cmd: string[], env: Record<string, string>) {
  const inheritedEnv = { ...process.env };
  delete inheritedEnv.PRX_AGENT_ROLE;
  delete inheritedEnv.PRX_CAPABILITY_STATE;
  delete inheritedEnv.PRX_SAFE_DRY_RUN;

  return Bun.spawnSync({
    cmd,
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...inheritedEnv,
      ...env,
    },
  });
}

function tempDir(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function stderrText(result: Bun.SyncSubprocess): string {
  return new TextDecoder().decode(result.stderr).trim();
}

describe("safe tool wrappers", () => {
  test("git-safe blocks destructive reset", () => {
    const result = run([join(repoRoot, "scripts/git-safe"), "reset", "--hard"]);
    expect(result.exitCode).toBe(1);
    expect(stderrText(result)).toContain("blocked subcommand 'reset'");
  });

  test("gh-safe blocks non-pr group", () => {
    const result = run([join(repoRoot, "scripts/gh-safe"), "repo", "view"]);
    expect(result.exitCode).toBe(1);
    expect(stderrText(result)).toContain("only 'pr' group is allowed");
  });

  test("gh-safe blocks merge", () => {
    const result = runWithEnv(
      [join(repoRoot, "scripts/gh-safe"), "pr", "merge", "1"],
      {
        PRX_CAPABILITY_STATE: "validating",
        PRX_SAFE_DRY_RUN: "1",
      },
    );
    expect(result.exitCode).toBe(1);
    expect(stderrText(result)).toContain("blocked subcommand 'merge'");
  });

  test("bd-safe blocks close", () => {
    const result = run([join(repoRoot, "scripts/bd-safe"), "close", "BEAD-1"]);
    expect(result.exitCode).toBe(1);
    expect(stderrText(result)).toContain("blocked subcommand 'close'");
  });

  test("git-safe nudges 'prx repo-status' on status", () => {
    const result = runWithEnv(
      [join(repoRoot, "scripts/git-safe"), "status"],
      {
        PRX_CAPABILITY_STATE: "planning",
        PRX_SAFE_DRY_RUN: "1",
      },
    );
    expect(stderrText(result)).toContain(
      "git-safe: prefer 'prx repo-status' (this is a safety wrapper)",
    );
  });

  test("git-safe emits generic nudge on unmapped verb", () => {
    const result = runWithEnv(
      [join(repoRoot, "scripts/git-safe"), "diff"],
      {
        PRX_CAPABILITY_STATE: "validating",
        PRX_SAFE_DRY_RUN: "1",
      },
    );
    expect(stderrText(result)).toContain(
      "git-safe: prefer 'prx diff' (this is a safety wrapper)",
    );
  });

  test("gh-safe nudges 'prx repo overview' on list", () => {
    const result = runWithEnv(
      [join(repoRoot, "scripts/gh-safe"), "pr", "list"],
      {
        PRX_CAPABILITY_STATE: "validating",
        PRX_SAFE_DRY_RUN: "1",
      },
    );
    expect(stderrText(result)).toContain(
      "gh-safe: prefer 'prx repo overview' (this is a safety wrapper)",
    );
  });

  test("gh-safe nudges 'prx review' on review", () => {
    const result = runWithEnv(
      [join(repoRoot, "scripts/gh-safe"), "pr", "review", "1"],
      {
        PRX_CAPABILITY_STATE: "validating",
        PRX_SAFE_DRY_RUN: "1",
      },
    );
    expect(stderrText(result)).toContain(
      "gh-safe: prefer 'prx review' (this is a safety wrapper)",
    );
  });

  test("bd-safe emits generic nudge on list", () => {
    const result = runWithEnv(
      [join(repoRoot, "scripts/bd-safe"), "list"],
      {
        PRX_CAPABILITY_STATE: "validating",
        PRX_SAFE_DRY_RUN: "1",
      },
    );
    expect(stderrText(result)).toContain(
      "bd-safe: prefer 'prx list' (this is a safety wrapper)",
    );
  });

  test("prx-safe blocks recursive session entry commands", () => {
    for (const sub of ["work", "open"] as const) {
      const result = run([join(repoRoot, "scripts/prx-safe"), sub, "GH-1"]);
      expect(result.exitCode).toBe(1);
      expect(stderrText(result)).toContain(`blocked subcommand '${sub}'`);
    }
    const sessionShorthand = run([join(repoRoot, "scripts/prx-safe"), "session", "GH-1"]);
    expect(sessionShorthand.exitCode).toBe(1);
    expect(stderrText(sessionShorthand)).toContain("blocked session open shorthand");

    // GH-678: `prx session open` is now allowed under the policy (required to
    // spawn the tmux session persistence layer). The bare-session block and
    // `session GH-N` shorthand block are unchanged.
    const bareSession = run([join(repoRoot, "scripts/prx-safe"), "session"]);
    expect(bareSession.exitCode).toBe(1);
    expect(stderrText(bareSession)).toContain("blocked session invocation");

    // Positive regression guard: `prx-safe session open ...` must pass the
    // wrapper's early blocklist. `PRX_SAFE_DRY_RUN=1` short-circuits before
    // the downstream `prx` binary runs, so this doesn't depend on any real
    // worktree state. If a future edit re-blocks `session open`, this test
    // flips to fail.
    const sessionOpen = runWithEnv(
      [join(repoRoot, "scripts/prx-safe"), "session", "open", "GH-1"],
      { PRX_SAFE_DRY_RUN: "1", PRX_CAPABILITY_STATE: "validating" },
    );
    expect(stderrText(sessionOpen)).not.toContain("blocked session invocation");
    expect(stderrText(sessionOpen)).not.toContain("blocked session open shorthand");
    expect(stderrText(sessionOpen)).toContain("allow 'session'");
  });

  test("git-safe enforces capability matrix by state", () => {
    const blockedInPlanning = runWithEnv(
      [join(repoRoot, "scripts/git-safe"), "commit", "-m", "x"],
      {
        PRX_CAPABILITY_STATE: "planning",
        PRX_SAFE_DRY_RUN: "1",
      },
    );
    expect(blockedInPlanning.exitCode).toBe(1);
    expect(stderrText(blockedInPlanning)).toContain("blocked subcommand 'commit' for state 'planning'");

    const allowedInValidating = runWithEnv(
      [join(repoRoot, "scripts/git-safe"), "commit", "-m", "x"],
      {
        PRX_CAPABILITY_STATE: "validating",
        PRX_SAFE_DRY_RUN: "1",
      },
    );
    expect(allowedInValidating.exitCode).toBe(0);
    expect(stderrText(allowedInValidating)).toContain("allow 'commit' for state 'validating'");
  });

  test("gh-safe blocks merge for all roles", () => {
    const blocked = runWithEnv(
      [join(repoRoot, "scripts/gh-safe"), "pr", "merge", "1"],
      {
        PRX_CAPABILITY_STATE: "validating",
        PRX_SAFE_DRY_RUN: "1",
      },
    );
    expect(blocked.exitCode).toBe(1);
    expect(stderrText(blocked)).toContain("blocked subcommand 'merge' for state 'validating' role 'executor'");

    const stillBlocked = runWithEnv(
      [join(repoRoot, "scripts/gh-safe"), "pr", "merge", "1"],
      {
        PRX_CAPABILITY_STATE: "merging",
        PRX_SAFE_DRY_RUN: "1",
      },
    );
    expect(stillBlocked.exitCode).toBe(1);
    expect(stderrText(stillBlocked)).toContain("blocked subcommand 'merge' for state 'merging' role 'executor'");
  });

  test("prx-safe allows workflow reads in planning state", () => {
    const result = runWithEnv(
      [join(repoRoot, "scripts/prx-safe"), "snapshot", "--format", "json"],
      {
        PRX_CAPABILITY_STATE: "planning",
        PRX_SAFE_DRY_RUN: "1",
      },
    );
    expect(result.exitCode).toBe(0);
    expect(stderrText(result)).toContain("allow 'snapshot' for state 'planning'");
  });

  test("prx-safe blocks transition in planning state", () => {
    const result = runWithEnv(
      [join(repoRoot, "scripts/prx-safe"), "transition", "--to", "in_review"],
      {
        PRX_CAPABILITY_STATE: "planning",
        PRX_SAFE_DRY_RUN: "1",
      },
    );
    expect(result.exitCode).toBe(1);
    expect(stderrText(result)).toContain("blocked subcommand 'transition' for state 'planning'");
  });

  test("prx-safe allows transition in validating state", () => {
    const result = runWithEnv(
      [join(repoRoot, "scripts/prx-safe"), "transition", "--to", "in_review"],
      {
        PRX_CAPABILITY_STATE: "validating",
        PRX_SAFE_DRY_RUN: "1",
      },
    );
    expect(result.exitCode).toBe(0);
    expect(stderrText(result)).toContain("allow 'transition' for state 'validating' role 'executor'");
  });

  test("cursor-agent-prx appends json format and passes prompt to cursor-agent", () => {
    const binDir = tempDir("cursor-agent-prx-");
    const prxSafeStub = join(binDir, "prx-safe-stub");
    const cursorAgentStub = join(binDir, "cursor-agent-stub");
    const prxLog = join(binDir, "prx.log");
    const cursorLog = join(binDir, "cursor.log");

    writeFileSync(
      prxSafeStub,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" > "$PRX_LOG"
printf '{"phase":"planning"}'
`,
      { mode: 0o755 },
    );

    writeFileSync(
      cursorAgentStub,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" > "$CURSOR_LOG"
`,
      { mode: 0o755 },
    );

    const result = runWithEnv([join(repoRoot, "scripts/cursor-agent-prx"), "snapshot"], {
      CURSOR_AGENT_PRX_PRX_SAFE_BIN: prxSafeStub,
      CURSOR_AGENT_PRX_CURSOR_AGENT_BIN: cursorAgentStub,
      PRX_LOG: prxLog,
      CURSOR_LOG: cursorLog,
    });

    expect(result.exitCode).toBe(0);
    expect(Bun.file(prxLog).text()).resolves.toBe("snapshot --format json\n");
    expect(Bun.file(cursorLog).text()).resolves.toBe(
      `--print --output-format text --workspace ${repoRoot} --sandbox enabled --trust {"phase":"planning"}\n`,
    );
  });

  test("cursor-agent-prx preserves explicit format", () => {
    const binDir = tempDir("cursor-agent-prx-format-");
    const prxSafeStub = join(binDir, "prx-safe-stub");
    const cursorAgentStub = join(binDir, "cursor-agent-stub");
    const prxLog = join(binDir, "prx.log");

    writeFileSync(
      prxSafeStub,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" > "$PRX_LOG"
printf '{}'
`,
      { mode: 0o755 },
    );

    writeFileSync(
      cursorAgentStub,
      "#!/usr/bin/env bash\nexit 0\n",
      { mode: 0o755 },
    );

    const result = runWithEnv(
      [join(repoRoot, "scripts/cursor-agent-prx"), "snapshot", "--format", "text"],
      {
        CURSOR_AGENT_PRX_PRX_SAFE_BIN: prxSafeStub,
        CURSOR_AGENT_PRX_CURSOR_AGENT_BIN: cursorAgentStub,
        PRX_LOG: prxLog,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(Bun.file(prxLog).text()).resolves.toBe("snapshot --format text\n");
  });

  test("cursor-agent-prx passes explicit model and can disable trust", () => {
    const binDir = tempDir("cursor-agent-prx-model-");
    const prxSafeStub = join(binDir, "prx-safe-stub");
    const cursorAgentStub = join(binDir, "cursor-agent-stub");
    const cursorLog = join(binDir, "cursor.log");

    writeFileSync(
      prxSafeStub,
      "#!/usr/bin/env bash\nprintf '{}'\n",
      { mode: 0o755 },
    );

    writeFileSync(
      cursorAgentStub,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" > "$CURSOR_LOG"
`,
      { mode: 0o755 },
    );

    const result = runWithEnv([join(repoRoot, "scripts/cursor-agent-prx"), "snapshot"], {
      CURSOR_AGENT_PRX_PRX_SAFE_BIN: prxSafeStub,
      CURSOR_AGENT_PRX_CURSOR_AGENT_BIN: cursorAgentStub,
      CURSOR_AGENT_PRX_OUTPUT_FORMAT: "json",
      CURSOR_AGENT_PRX_SANDBOX: "disabled",
      CURSOR_AGENT_PRX_WORKSPACE: "/tmp/custom-workspace",
      CURSOR_AGENT_PRX_TRUST: "0",
      CURSOR_AGENT_PRX_MODEL: "gpt-5",
      CURSOR_LOG: cursorLog,
    });

    expect(result.exitCode).toBe(0);
    expect(Bun.file(cursorLog).text()).resolves.toBe(
      "--print --output-format json --workspace /tmp/custom-workspace --sandbox disabled --model gpt-5 {}\n",
    );
  });

  test("cursor-agent-prx fails clearly when prx-safe wrapper is missing", () => {
    const result = runWithEnv([join(repoRoot, "scripts/cursor-agent-prx"), "snapshot"], {
      CURSOR_AGENT_PRX_PRX_SAFE_BIN: "/tmp/does-not-exist",
    });

    expect(result.exitCode).toBe(1);
    expect(stderrText(result)).toContain("missing executable prx-safe wrapper");
  });

  test.skipIf(!existsSync(join(monoRoot, "hooks/pre-commit")))("hooks pre-commit blocks commits on main", () => {
    const result = runWithEnv(["sh", join(monoRoot, "hooks/pre-commit")], {
      MAIN_GUARD_CURRENT_BRANCH: "main",
    });

    expect(result.exitCode).toBe(1);
    expect(stderrText(result)).toContain("refusing to commit on 'main'");
    expect(stderrText(result)).toContain("wt switch <branch>");
  });

  test.skipIf(!existsSync(join(monoRoot, "hooks/pre-commit")))("hooks pre-commit allows feature branches", () => {
    const result = runWithEnv(["sh", join(monoRoot, "hooks/pre-commit")], {
      MAIN_GUARD_CURRENT_BRANCH: "cursor-agent-hardening",
      PATH: "/usr/bin:/bin",
    });

    expect(result.exitCode).toBe(0);
  });

  test.skipIf(!existsSync(join(monoRoot, "hooks/pre-commit")))("hooks pre-commit tolerates beads timeouts under errexit", () => {
    const binDir = tempDir("main-guard-pre-commit-");
    const timeoutStub = join(binDir, "timeout");
    const bdStub = join(binDir, "bd");

    writeFileSync(
      timeoutStub,
      `#!/usr/bin/env bash
exit 124
`,
      { mode: 0o755 },
    );

    writeFileSync(
      bdStub,
      `#!/usr/bin/env bash
exit 0
`,
      { mode: 0o755 },
    );

    const result = runWithEnv(["sh", join(monoRoot, "hooks/pre-commit")], {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      MAIN_GUARD_CURRENT_BRANCH: "main-guard",
      BEADS_HOOK_TIMEOUT: "1",
    });

    expect(result.exitCode).toBe(0);
    expect(stderrText(result)).toContain("timed out after 1s");
  });

  test("planner role blocks git commit even in validating state", () => {
    const result = runWithEnv(
      [join(repoRoot, "scripts/git-safe"), "commit", "-m", "x"],
      {
        PRX_CAPABILITY_STATE: "validating",
        PRX_AGENT_ROLE: "planner",
        PRX_SAFE_DRY_RUN: "1",
      },
    );
    expect(result.exitCode).toBe(1);
    expect(stderrText(result)).toContain("blocked subcommand 'commit' for state 'validating' role 'planner'");
  });

  test("planner role only allows read-only gh commands", () => {
    const blocked = runWithEnv(
      [join(repoRoot, "scripts/gh-safe"), "pr", "edit", "1"],
      {
        PRX_CAPABILITY_STATE: "planning",
        PRX_AGENT_ROLE: "planner",
        PRX_SAFE_DRY_RUN: "1",
      },
    );
    expect(blocked.exitCode).toBe(1);
    expect(stderrText(blocked)).toContain("blocked subcommand 'edit' for state 'planning' role 'planner'");

    const allowed = runWithEnv(
      [join(repoRoot, "scripts/gh-safe"), "pr", "view", "1"],
      {
        PRX_CAPABILITY_STATE: "planning",
        PRX_AGENT_ROLE: "planner",
        PRX_SAFE_DRY_RUN: "1",
      },
    );
    expect(allowed.exitCode).toBe(0);
    expect(stderrText(allowed)).toContain("allow 'view' for state 'planning' role 'planner'");
  });
});
