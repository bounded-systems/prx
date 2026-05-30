import { spawnCapture } from "@bounded-systems/proc";
import { basename } from "node:path";

import {
  runHomeUpdate as defaultRunHomeUpdate,
  type HomeUpdateOptions,
  type HomeUpdateDeps,
} from "./home-update.ts";
import {
  worktreeStatus as defaultWorktreeStatus,
  type WorktreeStatus,
  type CommandRunner,
  defaultRunner,
} from "./github.ts";

export type HomeSyncOptions = HomeUpdateOptions;

type SpawnResult = {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: Error;
};

export type HomeSyncSpawn = (
  file: string,
  args: string[],
  options: { cwd: string; encoding: "utf8" },
) => SpawnResult;

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

export type HomeSyncDeps = {
  cwd?: string;
  spawn?: HomeSyncSpawn;
  runner?: CommandRunner;
  worktreeStatus?: (path: string, runner?: CommandRunner) => WorktreeStatus;
  prepareMainx?: (toplevel: string) => string;
  runHomeUpdate?: (
    options: HomeUpdateOptions,
    output: Output,
    deps?: HomeUpdateDeps,
  ) => number;
  /** Forwarded to runHomeUpdate. Tests typically stub runHomeUpdate entirely; in prod this is omitted so runHomeUpdate falls back to its real defaults. */
  homeUpdateDeps?: HomeUpdateDeps;
};

const DETACH_TARGET = "origin/main";

function resolveToplevel(spawn: HomeSyncSpawn, cwd: string): string | null {
  const result = spawn("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (result.error) return null;
  if ((result.status ?? 1) !== 0) return null;
  const stdout = typeof result.stdout === "string" ? result.stdout : (result.stdout?.toString() ?? "");
  const trimmed = stdout.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function dirtySummary(status: WorktreeStatus): string {
  const parts: string[] = [];
  if (status.counts.staged > 0) parts.push(`${status.counts.staged} staged`);
  if (status.counts.unstaged > 0) parts.push(`${status.counts.unstaged} unstaged`);
  if (status.counts.untracked > 0) parts.push(`${status.counts.untracked} untracked`);
  if (status.counts.conflicts > 0) parts.push(`${status.counts.conflicts} conflicts`);
  return parts.length > 0 ? parts.join(", ") : "dirty";
}

function makeBufferingOutput(): { output: Output; logs: string[]; errs: string[] } {
  const logs: string[] = [];
  const errs: string[] = [];
  return {
    output: { log: (l) => logs.push(l), error: (e) => errs.push(e) },
    logs,
    errs,
  };
}

export function runHomeSync(
  options: HomeSyncOptions,
  output: Output,
  deps: HomeSyncDeps = {},
): number {
  const cwd = deps.cwd ?? process.cwd();
  const spawn: HomeSyncSpawn =
    deps.spawn ??
    ((file, args, opts) => {
      const r = spawnCapture([file, ...args], { cwd: opts.cwd });
      return {
        status: r.status,
        stdout: r.stdout,
        stderr: r.stderr,
        ...(r.error ? { error: r.error } : {}),
      };
    });
  const runner = deps.runner ?? defaultRunner;
  const wtStatus = deps.worktreeStatus ?? defaultWorktreeStatus;
  const runUpdate = deps.runHomeUpdate ?? defaultRunHomeUpdate;

  const toplevel = resolveToplevel(spawn, cwd);
  if (!toplevel) {
    output.error("prx home sync: not in a git repository (git rev-parse --show-toplevel failed)");
    return 2;
  }

  const wtName = basename(toplevel);
  if (wtName !== "mainx") {
    output.error(
      `prx home sync: must run from the mainx worktree (got "${wtName}"). Use \`prx delegate next\` for feature work.`,
    );
    return 2;
  }

  const status = wtStatus(toplevel, runner);
  if (!status.clean) {
    output.error(
      `prx home sync: refusing to sync — working tree is dirty (${dirtySummary(status)}). Inspect with \`git status\` and stash or commit first.`,
    );
    return 2;
  }

  if (options.dryRun) {
    const captured = makeBufferingOutput();
    const updateExit = runUpdate(options, captured.output, deps.homeUpdateDeps);

    if (options.format === "json") {
      const updatePayload = parseFirstJson(captured.logs);
      output.log(
        JSON.stringify(
          {
            dryRun: true,
            guards: { mainx: "ok", clean: "ok" },
            fetch: { ran: false, plan: ["git", "fetch", "origin"] },
            detach: { ran: false, plan: ["git", "checkout", "--detach", DETACH_TARGET] },
            homeUpdate: updatePayload ?? { logs: captured.logs },
            errors: captured.errs,
          },
          null,
          2,
        ),
      );
      for (const line of captured.errs) output.error(line);
    } else {
      output.log("prx home sync (dry-run)");
      output.log(`  worktree: ${toplevel}`);
      output.log(`  guards:   mainx ✓ clean ✓`);
      output.log(`  would run:`);
      output.log(`    git fetch origin`);
      output.log(`    git checkout --detach ${DETACH_TARGET}`);
      for (const line of captured.logs) output.log(line);
      for (const line of captured.errs) output.error(line);
    }
    return updateExit;
  }

  // Live run: prepareMainxWorktree does fetch + ensure-mainx + detach.
  // Failures are caught here so CLI output stays consistently formatted.
  const prepare = deps.prepareMainx;
  if (!prepare) {
    output.error("prx home sync: prepareMainx dependency missing (internal error)");
    return 1;
  }

  try {
    prepare(toplevel);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.error(`prx home sync: ${message}`);
    return 1;
  }

  if (options.format === "json") {
    const captured = makeBufferingOutput();
    const updateExit = runUpdate(options, captured.output, deps.homeUpdateDeps);
    const updatePayload = parseFirstJson(captured.logs);
    output.log(
      JSON.stringify(
        {
          dryRun: false,
          guards: { mainx: "ok", clean: "ok" },
          fetch: { ran: true },
          detach: { ran: true, target: DETACH_TARGET },
          homeUpdate: updatePayload ?? { logs: captured.logs },
        },
        null,
        2,
      ),
    );
    for (const line of captured.errs) output.error(line);
    return updateExit;
  }

  output.log(`prx home sync: mainx ✓ clean ✓ — fetched origin, detached at ${DETACH_TARGET}`);
  return runUpdate(options, output, deps.homeUpdateDeps);
}

function parseFirstJson(lines: string[]): unknown | null {
  // runHomeUpdate prints exactly one JSON.stringify(..., 2) block when
  // format=json. The payload may span multiple `output.log` calls if a
  // future change uses a logger that splits on newlines, so join + parse.
  const joined = lines.join("\n").trim();
  if (joined.length === 0) return null;
  try {
    return JSON.parse(joined);
  } catch {
    return null;
  }
}
