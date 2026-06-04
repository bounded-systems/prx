import { processEnv } from "@bounded-systems/env";
import { defaultRunner } from "@bounded-systems/proc";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { PRX_TMUX_SOCKET } from "@bounded-systems/prx-mux";

import {
  computeTmuxReconcile,
  formatTmuxReconcile,
  type TmuxReconcileDeps,
  type TmuxReconcileOptions,
  type TmuxReconcileResult,
} from "./tmux-reconcile.ts";

export type HomeUpdateSpawnResult = {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: Error;
};

export type HomeUpdateSpawn = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    stdio?: "inherit" | "pipe" | "ignore";
  },
) => HomeUpdateSpawnResult;

export type HomeUpdateDeps = {
  spawn?: HomeUpdateSpawn;
  readFile?: (path: string) => string;
  pathExists?: (path: string) => boolean;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  /**
   * Compute reconcile result without printing — `runHomeUpdate` composes the
   * payload itself so plain output gets one block and JSON output stays a
   * single parseable payload (GH-838).
   */
  computeTmuxReconcile?: (
    options: TmuxReconcileOptions,
    deps?: TmuxReconcileDeps,
  ) => { result: TmuxReconcileResult; exitCode: number };
};

export type HomeUpdateOptions = {
  flakeDir?: string | undefined;
  input?: string | undefined;
  dryRun: boolean;
  format: "plain" | "json";
  // prx-up2: when true, stream the raw `nix` / `home-manager switch` activation
  // log live (the old behavior). Default (false) captures it inside prx and
  // prints only a per-step progress line, surfaced warnings/errors, and the
  // summary — the full log is still dumped if a step fails.
  verbose?: boolean;
};

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

const DEFAULT_FLAKE_DIR = "~/.config/home-manager";
const DEFAULT_INPUT = "ai-home";

function resolveTildePath(path: string, homeDir: string): string {
  if (path === "~") return homeDir;
  if (path.startsWith("~/")) return resolve(homeDir, path.slice(2));
  return resolve(path);
}

export function resolveFlakeDir(
  options: HomeUpdateOptions,
  env: NodeJS.ProcessEnv,
  homeDir: string,
): string {
  if (options.flakeDir) return resolveTildePath(options.flakeDir, homeDir);
  const envValue = env.PRX_HOME_FLAKE_DIR;
  if (envValue) return resolveTildePath(envValue, homeDir);
  return resolveTildePath(DEFAULT_FLAKE_DIR, homeDir);
}

export function resolveInputName(
  options: HomeUpdateOptions,
  env: NodeJS.ProcessEnv,
): string {
  if (options.input) return options.input;
  const envValue = env.PRX_HOME_FLAKE_INPUT;
  if (envValue) return envValue;
  return DEFAULT_INPUT;
}

type LockReadResult =
  | { ok: true; rev: string | null }
  | { ok: false; message: string; exitCode: number };

function readLockRev(
  flakeDir: string,
  input: string,
  readFile: (path: string) => string,
): LockReadResult {
  const lockPath = resolve(flakeDir, "flake.lock");
  let parsed: { nodes?: Record<string, { locked?: { rev?: string } }> };
  try {
    parsed = JSON.parse(readFile(lockPath));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `prx home update: unable to parse ${lockPath}: ${message}`,
      exitCode: 2,
    };
  }
  const nodes = parsed?.nodes ?? {};
  const node = nodes[input];
  if (!node) {
    const available = Object.keys(nodes)
      .filter((k) => k !== "root")
      .sort();
    const availableText = available.length > 0 ? available.join(", ") : "(none)";
    return {
      ok: false,
      message: `prx home update: input "${input}" not found in ${lockPath}. Available inputs: ${availableText}`,
      exitCode: 2,
    };
  }
  return { ok: true, rev: node.locked?.rev ?? null };
}

function shortRev(rev: string | null): string {
  if (!rev) return "(none)";
  return rev.length > 7 ? rev.slice(0, 7) : rev;
}

// prx-up2: a captured child's combined stdout+stderr as text (empty when the
// child inherited the terminal, i.e. nothing was piped back).
function captureToText(result: HomeUpdateSpawnResult): string {
  const parts: string[] = [];
  for (const chunk of [result.stdout, result.stderr]) {
    if (chunk == null) continue;
    parts.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  }
  return parts.join("\n");
}

// Lines worth surfacing even in quiet mode — anything that smells like a problem
// the operator should see without scrolling the whole activation log.
const NOTEWORTHY_RE = /\b(error|warning|fail(?:ed|ure)?|refus|conflict|denied)\b/i;

function surfaceNoteworthy(captured: string, output: Output): void {
  for (const raw of captured.split("\n")) {
    const line = raw.trimEnd();
    if (line.trim() && NOTEWORTHY_RE.test(line)) output.error(`  ${line.trim()}`);
  }
}

// On a failed step, dump the captured log so quiet mode is still debuggable.
function dumpCaptured(captured: string, output: Output): void {
  const text = captured.trim();
  if (!text) return;
  output.error("  --- captured output ---");
  for (const raw of text.split("\n")) {
    output.error(`  ${raw.trimEnd()}`);
  }
}

export function runHomeUpdate(
  options: HomeUpdateOptions,
  output: Output,
  deps: HomeUpdateDeps = {},
): number {
  const spawn: HomeUpdateSpawn =
    deps.spawn ??
    ((file, args, opts) => {
      // defaultRunner throws on a spawn error (e.g. ENOENT) and, with the
      // check on, on a non-zero exit; this seam reports both through its
      // return shape, so disable the exit check and map a thrown error to
      // { status: null, error }.
      try {
        const result = defaultRunner([file, ...args], {
          cwd: opts.cwd,
          env: opts.env ?? processEnv(),
          stdio: opts.stdio === "pipe" ? "pipe" : "inherit",
          check: false,
        });
        return { status: result.status, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        return {
          status: null,
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    });
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const pathExists = deps.pathExists ?? ((path: string) => existsSync(path));
  const env = deps.env ?? processEnv();
  const homeDir = deps.homeDir ?? homedir();

  const flakeDir = resolveFlakeDir(options, env, homeDir);
  const input = resolveInputName(options, env);

  if (!pathExists(flakeDir)) {
    output.error(`prx home update: flake dir does not exist: ${flakeDir}`);
    return 2;
  }
  if (!pathExists(resolve(flakeDir, "flake.nix"))) {
    output.error(
      `prx home update: flake.nix not found at ${flakeDir} (not a flake directory)`,
    );
    return 2;
  }
  if (!pathExists(resolve(flakeDir, "flake.lock"))) {
    output.error(`prx home update: flake.lock not found at ${flakeDir}`);
    return 2;
  }

  const fromRead = readLockRev(flakeDir, input, readFile);
  if (!fromRead.ok) {
    output.error(fromRead.message);
    return fromRead.exitCode;
  }
  const fromRev = fromRead.rev;

  const nixUpdateCmd = ["nix", "flake", "update", input, "--flake", flakeDir];
  // prx-1ab: the lockfile commit that keeps the git+file flake tree clean for
  // the switch (run only when `nix flake update` actually moved the rev).
  const gitCommitCmd = ["git", "-C", flakeDir, "commit", "flake.lock", "-m", `chore(flake): update ${input}`];
  const hmSwitchCmd = ["home-manager", "switch", "--flake", flakeDir];

  if (options.dryRun) {
    // GH-838: in dry-run mode also preview the tmux reconcile so operators
    // see what would change on the live socket after the switch.
    const computeReconcile = deps.computeTmuxReconcile ?? computeTmuxReconcile;
    const reconcile = computeReconcile(
      {
        socket: PRX_TMUX_SOCKET,
        dryRun: true,
        format: options.format,
      },
      { env, homeDir },
    );
    if (options.format === "json") {
      output.log(
        JSON.stringify(
          {
            dryRun: true,
            flakeDir,
            input,
            from: fromRev,
            commands: [nixUpdateCmd, gitCommitCmd, hmSwitchCmd],
            tmuxReconcile: reconcile.result,
            tmuxReconcileNote: "preview based on current rendered config (pre-switch)",
          },
          null,
          2,
        ),
      );
    } else {
      output.log(`prx home update (dry-run)`);
      output.log(`  flake:  ${flakeDir}`);
      output.log(`  input:  ${input}`);
      output.log(`  rev:    ${shortRev(fromRev)}`);
      output.log(`  would run:`);
      output.log(`    ${nixUpdateCmd.join(" ")}`);
      output.log(`    ${gitCommitCmd.join(" ")}   (only if the rev moved)`);
      output.log(`    ${hmSwitchCmd.join(" ")}`);
      output.log(`  note: tmux reconcile preview is based on current rendered config (pre-switch)`);
      output.log(formatTmuxReconcile(reconcile.result, "plain", true));
    }
    return 0;
  }

  // prx-up2: stream the raw nix / home-manager activation log live only when the
  // operator asked for it (--verbose) or in JSON mode (where we always pipe so
  // stdout stays a single parseable payload). Otherwise capture it inside prx
  // and print a clean per-step summary — far less noise for `prx upgrade`.
  const streamLive = options.format !== "json" && options.verbose === true;
  const childStdio: "inherit" | "pipe" = streamLive ? "inherit" : "pipe";
  const quiet = options.format !== "json" && !options.verbose;
  if (options.format !== "json") {
    output.log(`prx home update: ${input} @ ${flakeDir}`);
  }

  if (quiet) output.log(`  updating flake input ${input}…`);
  const updateResult = spawn(
    nixUpdateCmd[0]!,
    nixUpdateCmd.slice(1),
    { cwd: flakeDir, stdio: childStdio, env },
  );
  if (updateResult.error) {
    output.error(
      `prx home update: failed to invoke nix: ${updateResult.error.message}`,
    );
    return 1;
  }
  if (updateResult.status !== 0) {
    output.error(
      `prx home update: nix flake update exited with status ${updateResult.status}`,
    );
    if (quiet) dumpCaptured(captureToText(updateResult), output);
    return updateResult.status ?? 1;
  }

  const toRead = readLockRev(flakeDir, input, readFile);
  if (!toRead.ok) {
    output.error(toRead.message);
    return toRead.exitCode;
  }
  const toRev = toRead.rev;

  // prx-1ab: `home-manager switch` evaluates the flake as a `git+file` input and
  // refuses on a dirty tree — and `nix flake update` just dirtied flake.lock.
  // Commit it here so the switch below "just works"; this is the manual step
  // that made updating a multi-command dance. Skipped on a no-op or a non-git
  // flake dir. A commit failure is surfaced (the switch will likely then refuse)
  // but does not abort — the operator sees a precise reason.
  if (fromRev !== toRev) {
    const isGit = spawn("git", ["-C", flakeDir, "rev-parse", "--git-dir"], {
      cwd: flakeDir,
      stdio: "pipe",
      env,
    });
    if (isGit.status === 0) {
      spawn("git", ["-C", flakeDir, "add", "flake.lock"], {
        cwd: flakeDir,
        stdio: childStdio,
        env,
      });
      const committed = spawn(
        "git",
        ["-C", flakeDir, "commit", "-m", `chore(flake): update ${input} ${shortRev(fromRev)} → ${shortRev(toRev)}`],
        { cwd: flakeDir, stdio: childStdio, env },
      );
      if (committed.error || (committed.status !== null && committed.status !== 0)) {
        output.error(
          `prx home update: committing flake.lock failed (status ${committed.status ?? "spawn-error"}); ` +
            "home-manager switch may refuse on the dirty tree.",
        );
      }
    }
  }

  if (quiet) output.log(`  switching home-manager generation…`);
  const switchResult = spawn(hmSwitchCmd[0]!, hmSwitchCmd.slice(1), {
    cwd: flakeDir,
    stdio: childStdio,
    env,
  });
  if (switchResult.error) {
    output.error(
      `prx home update: failed to invoke home-manager: ${switchResult.error.message}`,
    );
    return 1;
  }
  if (switchResult.status !== 0) {
    output.error(
      `prx home update: home-manager switch exited with status ${switchResult.status}`,
    );
    if (quiet) dumpCaptured(captureToText(switchResult), output);
    return switchResult.status ?? 1;
  }
  // Even on success, surface any warnings the activation log buried.
  if (quiet) surfaceNoteworthy(captureToText(switchResult), output);

  const noop = fromRev === toRev;

  // GH-838: after home-manager switch, the rendered ~/.config/tmux/tmux.conf
  // is up to date but the live `-L prx` server still holds its old in-memory
  // option values. Run reconcile so scalar options (focus-events,
  // allow-rename, set-titles, allow-passthrough, mouse, future knobs)
  // converge without manual `tmux set -g`. Reconcile failure is non-fatal —
  // the switch already succeeded — but the result is reported so operators
  // can see drift.
  const computeReconcile = deps.computeTmuxReconcile ?? computeTmuxReconcile;
  const reconcile = computeReconcile(
    {
      socket: PRX_TMUX_SOCKET,
      dryRun: options.dryRun,
      format: options.format,
    },
    { env, homeDir },
  );

  if (options.format === "json") {
    output.log(
      JSON.stringify(
        {
          flakeDir,
          input,
          from: fromRev,
          to: toRev,
          noop,
          switched: true,
          tmuxReconcile: reconcile.result,
        },
        null,
        2,
      ),
    );
  } else {
    if (noop) {
      output.log(`${input}: no-op (${shortRev(fromRev)}) — home-manager switched`);
    } else {
      output.log(
        `${input}: ${shortRev(fromRev)} → ${shortRev(toRev)} (home-manager switched)`,
      );
    }
    output.log(formatTmuxReconcile(reconcile.result, "plain", options.dryRun));
  }

  return 0;
}
