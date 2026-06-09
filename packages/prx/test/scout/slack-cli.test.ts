// CLI surface for `prx scout slack <op>` (prx-zes .9) — the scout source that
// runs the slack read composition root. Spawns the real entrypoint so the
// parse → dispatch → handler path matches production. The usage/validation
// cases never reach Slack; the no-credential case proves the handler wires the
// keymaker composition root (it fails closed before any network call).
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

describe("prx scout slack — dispatch + validation", () => {
  test("no op lists the read ops", () => {
    const r = runCli(["scout", "slack"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toContain("requires an op");
    expect(r.stderr + r.stdout).toMatch(/channels.*history.*thread.*users/);
  });

  test("an unknown op is rejected", () => {
    const r = runCli(["scout", "slack", "post"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toContain("requires an op");
  });

  test("history without --channel is refused", () => {
    const r = runCli(["scout", "slack", "history"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toContain("requires --channel");
  });

  test("thread without --ts is refused", () => {
    const r = runCli(["scout", "slack", "thread", "--channel", "C1"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toContain("requires --ts");
  });

  test("a bad --limit is refused", () => {
    const r = runCli(["scout", "slack", "channels", "--limit", "0"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toContain("--limit");
  });
});

describe("prx scout slack — handler wires the composition root", () => {
  test("with no Slack credential it fails closed (keymaker resolves the secret)", () => {
    // Strip any ambient token so createServiceKeymaker('slack') has nothing.
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.SLACK_TOKEN;
    delete env.SLACK_BOT_TOKEN;
    const r = runCli(["scout", "slack", "channels"], env);
    expect(r.code).not.toBe(0);
    expect((r.stderr + r.stdout).toLowerCase()).toContain("credential");
  });
});
