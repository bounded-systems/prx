import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const wrapperPath = join(repoRoot, "scripts", "bd-wrapper.sh");

type RunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

let stubDir: string;
let stubLogPath: string;
let stubTokenLogPath: string;
let stubBinPath: string;
let ghStubBinPath: string;
let ghStubLogPath: string;

beforeAll(() => {
  stubDir = mkdtempSync(join(tmpdir(), "bd-wrapper-stub-"));
  stubLogPath = join(stubDir, "calls.log");
  stubTokenLogPath = join(stubDir, "tokens.log");
  stubBinPath = join(stubDir, "bd-stub.sh");
  ghStubLogPath = join(stubDir, "gh-calls.log");
  ghStubBinPath = join(stubDir, "gh");
  // Stub upstream bd: append "$@" to calls.log (preserves the existing
  // single-line-per-call format), and the observed GITHUB_TOKEN to tokens.log
  // so auto-injection tests can assert what bd would have seen. Tests that
  // exercise the stderr-rewrite path set BD_STUB_STDOUT / BD_STUB_STDERR /
  // BD_STUB_EXIT to make the stub emit specific output on each stream and exit
  // with a specific code; unset, the stub behaves as before (silent, exit 0).
  writeFileSync(
    stubBinPath,
    [
      `#!/usr/bin/env bash`,
      `printf '%s\\n' "$*" >> "${stubLogPath}"`,
      `printf '%s\\n' "\${GITHUB_TOKEN:-}" >> "${stubTokenLogPath}"`,
      `[[ -n "\${BD_STUB_STDOUT:-}" ]] && printf '%s\\n' "\$BD_STUB_STDOUT"`,
      `[[ -n "\${BD_STUB_STDERR:-}" ]] && printf '%s\\n' "\$BD_STUB_STDERR" >&2`,
      `exit "\${BD_STUB_EXIT:-0}"`,
      ``,
    ].join("\n"),
    { mode: 0o755 },
  );
  chmodSync(stubBinPath, 0o755);
  // Stub `gh`: only responds to `gh auth token`; mode controlled by
  // GH_STUB_MODE. Logs every invocation so tests can assert (or verify
  // non-invocation for non-github subcommands).
  writeFileSync(
    ghStubBinPath,
    [
      `#!/usr/bin/env bash`,
      `printf '%s\\n' "$*" >> "\${GH_STUB_LOG:-/dev/null}"`,
      `if [[ "$1" == "auth" && "$2" == "token" ]]; then`,
      `  case "\${GH_STUB_MODE:-success}" in`,
      `    success) printf 'stub-token-value\\n'; exit 0 ;;`,
      `    fail) printf 'not logged in\\n' >&2; exit 1 ;;`,
      `    empty) exit 0 ;;`,
      `    whitespace) printf '   \\n'; exit 0 ;;`,
      `  esac`,
      `fi`,
      `exit 99`,
      ``,
    ].join("\n"),
    { mode: 0o755 },
  );
  chmodSync(ghStubBinPath, 0o755);
});

afterAll(() => {
  rmSync(stubDir, { recursive: true, force: true });
});

type RunOpts = {
  realBd?: string | null;
  // If set, prepend stubDir to PATH so `gh` resolves to the stub. Pass
  // `false` to inherit PATH unchanged (real `gh`, if any, may resolve).
  stubGh?: boolean;
  ghMode?: "success" | "fail" | "empty" | "whitespace";
  githubToken?: string | null;
  // Make the bd stub emit these on stdout/stderr and exit with this code.
  bdStubStdout?: string;
  bdStubStderr?: string;
  bdStubExit?: number;
};

function run(args: string[], opts?: RunOpts): RunResult {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (opts?.realBd === null) {
    delete env.REAL_BD;
  } else {
    env.REAL_BD = opts?.realBd ?? stubBinPath;
  }
  // GITHUB_TOKEN: explicit override > delete (to exercise the auto-detect path).
  if (opts?.githubToken === undefined || opts?.githubToken === null) {
    delete env.GITHUB_TOKEN;
  } else {
    env.GITHUB_TOKEN = opts.githubToken;
  }
  if (opts?.stubGh) {
    env.PATH = `${stubDir}:${env.PATH ?? ""}`;
    env.GH_STUB_LOG = ghStubLogPath;
    env.GH_STUB_MODE = opts.ghMode ?? "success";
  }
  if (opts?.bdStubStdout !== undefined) env.BD_STUB_STDOUT = opts.bdStubStdout;
  if (opts?.bdStubStderr !== undefined) env.BD_STUB_STDERR = opts.bdStubStderr;
  if (opts?.bdStubExit !== undefined) env.BD_STUB_EXIT = String(opts.bdStubExit);
  const result = Bun.spawnSync({
    cmd: ["bash", wrapperPath, ...args],
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
    exitCode: result.exitCode ?? -1,
  };
}

async function readStubCallsAsync(): Promise<string[]> {
  const file = Bun.file(stubLogPath);
  if (!(await file.exists())) return [];
  const text = await file.text();
  return text.split("\n").filter((line) => line.length > 0);
}

async function readStubTokensAsync(): Promise<string[]> {
  const file = Bun.file(stubTokenLogPath);
  if (!(await file.exists())) return [];
  const text = await file.text();
  // Split on \n but keep empty entries — tokens.log has exactly one line per
  // bd-stub invocation, so a blank line means "GITHUB_TOKEN was unset".
  // Drop only the trailing newline-induced empty element.
  const parts = text.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

async function readGhStubCallsAsync(): Promise<string[]> {
  const file = Bun.file(ghStubLogPath);
  if (!(await file.exists())) return [];
  const text = await file.text();
  return text.split("\n").filter((line) => line.length > 0);
}

function clearStubLog() {
  try {
    rmSync(stubLogPath);
  } catch {
    // ignore — stub log may not exist yet
  }
  try {
    rmSync(stubTokenLogPath);
  } catch {
    // ignore — token log may not exist yet
  }
  try {
    rmSync(ghStubLogPath);
  } catch {
    // ignore — gh stub log may not exist yet
  }
}

describe("bd-wrapper.sh — secret-shaped config set guard", () => {
  test("rejects bd config set github.token", async () => {
    clearStubLog();
    const r = run(["config", "set", "github.token", "gho_xxx"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/secret-shaped/i);
    expect(r.stderr).toContain("github.token");
    expect(await readStubCallsAsync()).toEqual([]);
  });

  test("rejects bd config set github.password", async () => {
    clearStubLog();
    const r = run(["config", "set", "github.password", "hunter2"]);
    expect(r.exitCode).toBe(1);
    expect(await readStubCallsAsync()).toEqual([]);
  });

  test("rejects bd config set with case-variant secret key", async () => {
    clearStubLog();
    const r = run(["config", "set", "GitHub.TOKEN", "gho_xxx"]);
    expect(r.exitCode).toBe(1);
    expect(await readStubCallsAsync()).toEqual([]);
  });

  test("rejects api_key, apikey, access_key variants", async () => {
    clearStubLog();
    expect(run(["config", "set", "service.api_key", "x"]).exitCode).toBe(1);
    expect(run(["config", "set", "service.apikey", "x"]).exitCode).toBe(1);
    expect(run(["config", "set", "aws.access_key", "x"]).exitCode).toBe(1);
    expect(run(["config", "set", "vault.credential", "x"]).exitCode).toBe(1);
    expect(run(["config", "set", "secrets.foo", "x"]).exitCode).toBe(1);
    expect(await readStubCallsAsync()).toEqual([]);
  });

  test("passes through bd config set github.repository", async () => {
    clearStubLog();
    const r = run(["config", "set", "github.repository", "owner/repo"]);
    expect(r.exitCode).toBe(0);
    const calls = await readStubCallsAsync();
    expect(calls).toEqual(["config set github.repository owner/repo"]);
  });

  test("passes through bd config set doctor.suppress.git-hooks", async () => {
    clearStubLog();
    const r = run(["config", "set", "doctor.suppress.git-hooks", "true"]);
    expect(r.exitCode).toBe(0);
    const calls = await readStubCallsAsync();
    expect(calls).toEqual(["config set doctor.suppress.git-hooks true"]);
  });

  test("passes through bd config get github.token (reads are not gated)", async () => {
    clearStubLog();
    const r = run(["config", "get", "github.token"]);
    expect(r.exitCode).toBe(0);
    const calls = await readStubCallsAsync();
    expect(calls).toEqual(["config get github.token"]);
  });

  test("passes through bd config unset github.token", async () => {
    clearStubLog();
    const r = run(["config", "unset", "github.token"]);
    expect(r.exitCode).toBe(0);
    const calls = await readStubCallsAsync();
    expect(calls).toEqual(["config unset github.token"]);
  });

  test("passes through bd config list", async () => {
    clearStubLog();
    const r = run(["config", "list"]);
    expect(r.exitCode).toBe(0);
    const calls = await readStubCallsAsync();
    expect(calls).toEqual(["config list"]);
  });

  test("passes through unrelated subcommands like bd ready", async () => {
    clearStubLog();
    const r = run(["ready"]);
    expect(r.exitCode).toBe(0);
    const calls = await readStubCallsAsync();
    expect(calls).toEqual(["ready"]);
  });

  test("passes through bd list with flags", async () => {
    clearStubLog();
    const r = run(["list", "--status=open", "--json"]);
    expect(r.exitCode).toBe(0);
    const calls = await readStubCallsAsync();
    expect(calls).toEqual(["list --status=open --json"]);
  });

  test("refuses to run when REAL_BD is unset (would recurse via PATH)", async () => {
    clearStubLog();
    const r = run(["ready"], { realBd: null });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/REAL_BD is unset/);
    expect(await readStubCallsAsync()).toEqual([]);
  });
});

// Mirrors src/tools/bd.ts:resolveBeadsGitHubSyncEnv at the wrapper boundary.
// Upstream bd v1.0.3+ no longer auto-detects from `gh auth token`
// (gastownhall/beads cmd/bd/github.go), so this wrapper restores the v1.0.0
// behavior for bare operator invocations. See GH-1123.
describe("bd-wrapper.sh — bd github auto-token injection", () => {
  test("preset GITHUB_TOKEN short-circuits — does not invoke gh", async () => {
    clearStubLog();
    const r = run(["github", "sync", "--pull-only"], {
      stubGh: true,
      ghMode: "success",
      githubToken: "preset-token",
    });
    expect(r.exitCode).toBe(0);
    expect(await readStubCallsAsync()).toEqual(["github sync --pull-only"]);
    expect(await readStubTokensAsync()).toEqual(["preset-token"]);
    // Wrapper must NOT call gh when GITHUB_TOKEN is already set.
    expect(await readGhStubCallsAsync()).toEqual([]);
  });

  test("empty GITHUB_TOKEN + gh auth token success → injects trimmed token", async () => {
    clearStubLog();
    const r = run(["github", "sync", "--pull-only", "--prefer-github"], {
      stubGh: true,
      ghMode: "success",
    });
    expect(r.exitCode).toBe(0);
    expect(await readStubCallsAsync()).toEqual(["github sync --pull-only --prefer-github"]);
    expect(await readStubTokensAsync()).toEqual(["stub-token-value"]);
    expect(await readGhStubCallsAsync()).toEqual(["auth token"]);
  });

  test("gh auth token failure passes through with GITHUB_TOKEN unset", async () => {
    clearStubLog();
    const r = run(["github", "sync"], { stubGh: true, ghMode: "fail" });
    // Wrapper does not mask the failure — bd-stub still runs (bd-side error
    // would surface in real use; here exit 0 because the stub ignores auth).
    expect(r.exitCode).toBe(0);
    expect(await readStubCallsAsync()).toEqual(["github sync"]);
    // Token log captured an empty line — bd saw GITHUB_TOKEN unset.
    expect(await readStubTokensAsync()).toEqual([""]);
  });

  test("gh auth token empty stdout passes through with GITHUB_TOKEN unset", async () => {
    clearStubLog();
    const r = run(["github", "sync"], { stubGh: true, ghMode: "empty" });
    expect(r.exitCode).toBe(0);
    expect(await readStubTokensAsync()).toEqual([""]);
  });

  test("gh auth token whitespace-only stdout passes through with GITHUB_TOKEN unset", async () => {
    clearStubLog();
    const r = run(["github", "sync"], { stubGh: true, ghMode: "whitespace" });
    expect(r.exitCode).toBe(0);
    expect(await readStubTokensAsync()).toEqual([""]);
  });

  test("non-github subcommands never invoke gh, even when GITHUB_TOKEN is unset", async () => {
    clearStubLog();
    const r = run(["ready"], { stubGh: true, ghMode: "success" });
    expect(r.exitCode).toBe(0);
    expect(await readStubCallsAsync()).toEqual(["ready"]);
    expect(await readGhStubCallsAsync()).toEqual([]);
    // bd-stub saw no GITHUB_TOKEN — wrapper did not touch the env for `ready`.
    expect(await readStubTokensAsync()).toEqual([""]);
  });

  test("gh missing from PATH does not crash — bd still runs", async () => {
    clearStubLog();
    // PATH = dirname(bash) so `bash`/`env` resolve but `gh` (in a different
    // directory on this host) does not. Verifies the `command -v gh` guard.
    const bashPath = Bun.which("bash");
    if (!bashPath) throw new Error("bash not found on host PATH");
    const bashDir = dirname(bashPath);
    const ghPath = Bun.which("gh");
    if (ghPath && dirname(ghPath) === bashDir) {
      // Defensive: if a host ever colocates gh with bash this test can't
      // distinguish presence from absence. Skip rather than false-pass.
      return;
    }
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    env.REAL_BD = stubBinPath;
    delete env.GITHUB_TOKEN;
    env.PATH = bashDir;
    const result = Bun.spawnSync({
      cmd: [bashPath, wrapperPath, "github", "sync"],
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(await readStubCallsAsync()).toEqual(["github sync"]);
    expect(await readStubTokensAsync()).toEqual([""]);
  });
});

// bd v1.0.3 runs `git add .beads/issues.jsonl` after every write; `.beads/` is
// git-excluded in every ai-home clone (GH-444 mainx invariant), so that add
// always fails and bd prints a bare `Warning: auto-export: git add failed: exit
// status 1` — which reads as "the write failed" and once caused a phantom-dup
// retry (2026-05-11 mainx incident). The wrapper filters stderr to rewrite that
// line into an explicit "skipped, not failed" message. See GH-1112.
describe("bd-wrapper.sh — auto-export warning rewrite", () => {
  test("rewrites the auto-export warning, leaves stdout untouched, preserves exit 0", async () => {
    clearStubLog();
    const r = run(["create", "smoke"], {
      bdStubStdout: "Created issue: ai-home-abc12",
      bdStubStderr: [
        "Warning: auto-export: git add failed: exit status 1",
        "The following paths are ignored by one of your .gitignore files:",
        ".beads",
        "hint: Use -f if you really want to add them.",
      ].join("\n"),
      bdStubExit: 0,
    });
    expect(r.exitCode).toBe(0);
    // stdout passes through verbatim.
    expect(r.stdout).toBe("Created issue: ai-home-abc12\n");
    // The misleading wording is gone…
    expect(r.stderr).not.toContain("git add failed");
    expect(r.stderr).not.toContain("The following paths are ignored");
    expect(r.stderr).not.toContain("hint: Use -f");
    // …replaced by the explicit "skipped, not failed" line.
    expect(r.stderr).toContain("bd-wrapper: auto-export to git skipped");
    expect(r.stderr).toContain("The bd write above still succeeded");
    expect(r.stderr).toContain("GH-1112");
    // bd still ran with the original args.
    expect(await readStubCallsAsync()).toEqual(["create smoke"]);
  });

  test("passes unrelated stderr lines through verbatim and preserves a non-zero exit", async () => {
    clearStubLog();
    const r = run(["create", "smoke"], {
      bdStubStderr: "Warning: something else entirely",
      bdStubExit: 1,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Warning: something else entirely");
    expect(r.stderr).not.toContain("bd-wrapper: auto-export");
  });

  test("preserves bd's exit code when stderr is clean (regression guard for exec → run-filter)", async () => {
    clearStubLog();
    const r = run(["dep", "add", "ai-home-1", "ai-home-2"], { bdStubExit: 2 });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("");
    expect(await readStubCallsAsync()).toEqual(["dep add ai-home-1 ai-home-2"]);
  });
});
