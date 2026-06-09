// CLI surface for `prx fetch slack <channel>` (prx-agd). Spawns the real
// entrypoint so parse → dispatch → handler matches production. The
// usage/validation cases never reach Slack; the no-credential case proves the
// handler wires the read composition root (it fails closed before any network
// call).
import { describe, expect, test } from "bun:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = join(repoRoot, "scripts/pr_state.ts");

function runCli(args: string[], env?: Record<string, string | undefined>) {
  const r = Bun.spawnSync({
    cmd: ["bun", "run", scriptPath, ...args],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    ...(env ? { env } : {}),
  });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

describe("prx fetch slack — dispatch + validation", () => {
  test("bare `fetch` lists the subcommands", () => {
    const r = runCli(["fetch"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/gh-issues.*slack/);
  });

  test("an unknown fetch subcommand is rejected and lists slack", () => {
    const r = runCli(["fetch", "bogus"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/Unknown fetch subcommand.*slack/);
  });

  test("slack without a channel is refused", () => {
    const r = runCli(["fetch", "slack"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toContain("requires a channel");
  });

  test("more than one channel positional is refused", () => {
    const r = runCli(["fetch", "slack", "C1", "C2"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toContain("exactly one channel");
  });

  test("a bad --limit is refused", () => {
    const r = runCli(["fetch", "slack", "C1", "--limit", "0"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toContain("--limit");
  });
});

describe("prx fetch slack — handler wires the composition root", () => {
  // Fails closed when it can't run authenticated. Stripping the Slack token
  // exercises the fail-closed contract, but WHICH gate fires first depends on
  // the host: with a usable bd the watermark read succeeds and the keymaker
  // rejects the missing credential; without bd (CI) it fails earlier at
  // WATERMARK_READ_FAILED. Both are fail-closed with no network call, so the
  // portable contract is: a non-zero exit and NO success `_summary` (nothing
  // was synced). Asserting a specific error string would couple the test to
  // whether bd happens to be on PATH (it isn't in CI).
  test("with no Slack credential it fails closed (no sync) before any network call", () => {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.SLACK_TOKEN;
    delete env.SLACK_BOT_TOKEN;
    const r = runCli(["fetch", "slack", "C1"], env);
    const out = r.stderr + r.stdout;
    expect(r.code).not.toBe(0); // fails closed
    expect(out.trim()).not.toBe(""); // emitted a diagnostic
    expect(out).not.toContain("_summary"); // proves nothing was synced
  });
});
