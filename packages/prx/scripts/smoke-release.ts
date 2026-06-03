#!/usr/bin/env bun
/**
 * prx-r2w — release/build smoke harness.
 *
 * Purpose: never ship a binary that's broken in a way `--version` won't reveal.
 * The bugs this session shipped (and re-shipped) all ran `--version` fine:
 *   - prx-jkb: materialized triage/intake worktrees spawned a stray Dolt server
 *     instead of writing `.beads/redirect` to the launching workspace.
 *   - prx-5el: `prx plan session` / headless agents threw "Native CLI binary
 *     for darwin-arm64 not found" because the bun-compiled binary lacks the
 *     agent-SDK's native helper.
 * Each smoke below *actually exercises* the broken path, not a proxy.
 *
 * Usage:
 *   bun packages/prx/scripts/smoke-release.ts [path-to-prx]   # default: `prx` on PATH
 *
 * Exit code: 0 iff every non-skipped smoke passes. Skips (missing claude / Dolt
 * server) are not failures — they mean that smoke can't run in this env (e.g.
 * CI without claude); run the full set locally before tagging a release.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PRX = process.argv[2] ?? "prx";

type Outcome = { ok: boolean; detail: string } | { skip: string };
const results: { name: string; ok: boolean; detail: string; skipped: boolean }[] = [];

function smoke(name: string, fn: () => Outcome): void {
  let outcome: Outcome;
  try {
    outcome = fn();
  } catch (err) {
    outcome = { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
  if ("skip" in outcome) {
    results.push({ name, ok: true, skipped: true, detail: outcome.skip });
  } else {
    results.push({ name, ok: outcome.ok, skipped: false, detail: outcome.detail });
  }
}

function prx(
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; pty?: boolean; env?: Record<string, string> } = {},
) {
  // A PTY (`script -q /dev/null …`) is only needed for the interactive agent
  // path; the materialize smoke uses PRX_SESSION_NO_LAUNCH instead (no PTY).
  const [file, argv] = opts.pty
    ? ["script", ["-q", "/dev/null", PRX, ...args]]
    : [PRX, args];
  const r = spawnSync(file as string, argv as string[], {
    cwd: opts.cwd,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 60_000,
    input: "",
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function onPath(bin: string): boolean {
  return spawnSync("which", [bin], { encoding: "utf8" }).status === 0;
}
function doltServers(): number {
  const r = spawnSync("bash", ["-c", "ps aux | grep '[d]olt sql-server' | wc -l"], { encoding: "utf8" });
  return Number((r.stdout ?? "0").trim()) || 0;
}
function triageWorktrees(repoGitDir: string): string[] {
  const base = join(repoGitDir, "triage");
  const r = spawnSync("bash", ["-c", `ls -d ${base}/*/ 2>/dev/null || true`], { encoding: "utf8" });
  return (r.stdout ?? "").trim().split("\n").filter(Boolean);
}

// --- 1. binary runs at all ------------------------------------------------
smoke("version", () => {
  const { status, out } = prx(["--version"]);
  const v = out.trim().split("\n")[0] ?? "";
  const ok = status === 0 && /(git-[0-9a-f]{6,}|v?\d+\.\d+\.\d+)/.test(v);
  return { ok, detail: v || `exit=${status}` };
});

smoke("help", () => {
  const { status } = prx(["--help"]);
  return { ok: status === 0, detail: `exit=${status}` };
});

// --- 2. agent-SDK launches (prx-5el) --------------------------------------
// The headless agent goes through the agent-SDK query() path that fails when
// the compiled binary can't resolve the SDK's native helper.
smoke("agent-sdk-launch", () => {
  if (!onPath("claude")) return { skip: "claude not on PATH" };
  const { out } = prx(["triage", "agent"], { timeoutMs: 25_000 });
  const broken = /Native CLI binary for .*not found/i.test(out);
  return {
    ok: !broken,
    detail: broken ? "agent-SDK native helper missing (prx-5el)" : "agent-SDK launched",
  };
});

// --- 3. materialized worktree redirects to the launching beads (prx-jkb) ---
// PRX_SESSION_NO_LAUNCH (prx-r2w) stops openSession after materialize + prepare:
// the worktree exists with its `.beads/redirect`, but no claude/PTY/agent-SDK is
// touched. That makes this smoke CI-grade — it exercises the exact materialize→
// redirect path that prx-jkb regressed, with zero interactive dependencies.
smoke("materialize-redirect", () => {
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status !== 0) return { skip: "not in a git worktree" };
  // The triage/<dated> worktrees live as siblings under the bare-repo worktrees dir.
  const wtRoot = join((top.stdout ?? "").trim(), "..");
  if (doltServers() === 0) return { skip: "no Dolt server running (start the shared server first)" };

  const before = new Set(triageWorktrees(wtRoot));
  prx(["triage", "agent"], { env: { PRX_SESSION_NO_LAUNCH: "1" }, timeoutMs: 30_000 });
  const after = triageWorktrees(wtRoot);
  const fresh = after.find((w) => !before.has(w));
  if (!fresh) return { ok: false, detail: "agent did not materialize a new triage worktree" };

  const redirect = join(fresh, ".beads", "redirect");
  const hasRedirect = existsSync(redirect);
  const target = hasRedirect ? readFileSync(redirect, "utf8").trim() : "";
  const spawnedStray = existsSync(join(fresh, ".beads", "dolt-server.port"));

  // best-effort cleanup of the throwaway worktree
  spawnSync("git", ["worktree", "remove", "--force", fresh], { encoding: "utf8" });

  if (!hasRedirect) return { ok: false, detail: `no .beads/redirect in ${fresh} (prx-jkb regression)` };
  if (spawnedStray) return { ok: false, detail: `stray dolt-server.port spawned in ${fresh} (prx-jkb)` };
  return { ok: true, detail: `redirect → ${target}, no stray` };
});

// --- 4. every lifecycle step is `prx <actor> agent` (prx-383) --------------
// The uniform headless chain: intake → triage → plan → implement → submit →
// author. A regression that drops (or renames) any `agent` verb breaks the
// operator's single-verb workflow; this catches it.
smoke("uniform-agent-chain", () => {
  const actors = ["intake", "triage", "plan", "implement", "submit", "author"];
  const unrecognized =
    /unknown .*subcommand|requires a subcommand|is no longer a verb|no SessionEntryEvent matched/i;
  const missing = actors.filter((a) => unrecognized.test(prx([a, "agent", "--help"]).out));
  return {
    ok: missing.length === 0,
    detail: missing.length
      ? `not a verb: ${missing.map((a) => `prx ${a} agent`).join(", ")}`
      : "all six prx <actor> agent verbs route",
  };
});

// --- 5. `prx intake agent --message` seeds the headless prompt (prx-28w) ----
// The free-text front door: the seed must reach the intake operator's prompt so
// it intakes THAT item instead of sweeping the queue.
smoke("intake-message-seed", () => {
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status !== 0) return { skip: "not in a git worktree" };
  const probe = "smoke-probe: the readme is out of date";
  const { out } = prx(
    ["intake", "agent", "--message", probe, "--dry-run", "--format", "json"],
    { cwd: (top.stdout ?? "").trim() },
  );
  const seeded = /operator reports/i.test(out) && out.includes("readme is out of date");
  return {
    ok: seeded,
    detail: seeded
      ? "--message threads into the headless intake prompt"
      : "seed not found in the dry-run profile",
  };
});

// --- report ---------------------------------------------------------------
let failed = 0;
for (const r of results) {
  const tag = r.skipped ? "SKIP" : r.ok ? "PASS" : "FAIL";
  if (!r.ok && !r.skipped) failed += 1;
  console.log(`[${tag}] ${r.name} — ${r.detail}`);
}
console.log(failed === 0 ? "\nsmoke-release: OK" : `\nsmoke-release: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
