import { processEnv } from "@bounded-systems/env";
import { defaultRunner } from "@bounded-systems/proc";
import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

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
  /**
   * Read the target of a symlink (best-effort). Used to detect the
   * home-manager generation before/after the switch via the profile symlink.
   * Returns null on any error so generation detection degrades gracefully to
   * the prior wording when the profile path is unreadable.
   */
  readlink?: (path: string) => string | null;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
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
// prx-9lc: the bare `prx home update` default. `prx upgrade` requests the
// coupled `prx,ai-home` pair so the consumer (ai-home) never drifts ahead of
// the hm modules it imports from prx.
const DEFAULT_INPUTS = ["ai-home"];

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

// prx-9lc: `--input` / PRX_HOME_FLAKE_INPUT carry a comma-separated list so a
// single run can update a coupled set of inputs (e.g. `prx,ai-home`). Empty /
// whitespace-only entries are dropped; an empty list falls back to the bare
// default.
export function resolveInputNames(
  options: HomeUpdateOptions,
  env: NodeJS.ProcessEnv,
): string[] {
  const raw = options.input ?? env.PRX_HOME_FLAKE_INPUT ?? "";
  const names = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return names.length > 0 ? names : [...DEFAULT_INPUTS];
}

type LockRevsResult =
  | {
      ok: true;
      revs: Map<string, string | null>;
      missing: string[];
      available: string[];
    }
  | { ok: false; message: string; exitCode: number };

// prx-9lc: read each requested input's locked rev in a single parse of
// flake.lock. Inputs absent from the lock are reported via `missing` (the
// caller decides warn-and-skip vs. hard-fail), so the function only fails hard
// on an unparseable lockfile.
function readLockRevs(
  flakeDir: string,
  inputs: string[],
  readFile: (path: string) => string,
): LockRevsResult {
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
  const revs = new Map<string, string | null>();
  const missing: string[] = [];
  for (const input of inputs) {
    const node = nodes[input];
    if (!node) {
      missing.push(input);
    } else {
      revs.set(input, node.locked?.rev ?? null);
    }
  }
  const available = Object.keys(nodes)
    .filter((k) => k !== "root")
    .sort();
  return { ok: true, revs, missing, available };
}

function shortRev(rev: string | null): string {
  if (!rev) return "(none)";
  return rev.length > 7 ? rev.slice(0, 7) : rev;
}

// The home-manager profile symlink whose target encodes the active generation
// (`home-manager-<N>-link`). Honors XDG_STATE_HOME, falling back to the
// conventional ~/.local/state location.
function homeManagerProfilePath(env: NodeJS.ProcessEnv, homeDir: string): string {
  const xdgState = env.XDG_STATE_HOME;
  const base = xdgState && xdgState.length > 0 ? xdgState : resolve(homeDir, ".local/state");
  return resolve(base, "nix", "profiles", "home-manager");
}

// Best-effort current home-manager generation number, or null when the profile
// symlink can't be read or its target doesn't match the expected shape.
function readGeneration(
  readlink: (path: string) => string | null,
  env: NodeJS.ProcessEnv,
  homeDir: string,
): number | null {
  const target = readlink(homeManagerProfilePath(env, homeDir));
  if (!target) return null;
  const match = target.match(/home-manager-(\d+)-link/);
  if (!match) return null;
  const n = Number.parseInt(match[1]!, 10);
  return Number.isFinite(n) ? n : null;
}

// Report what the switch did as its own fact, independent of whether any input
// moved. Names the generation number when it could be read; otherwise falls
// back to the prior wording so the feature degrades without erroring.
function switchSummaryLine(
  noop: boolean,
  genBefore: number | null,
  genAfter: number | null,
): string {
  if (genAfter !== null) {
    if (genBefore !== null && genBefore !== genAfter) {
      return `home-manager switched → generation ${genAfter}`;
    }
    if (!noop) {
      return `home-manager switched (generation ${genAfter}, unchanged)`;
    }
    return `home-manager already current (generation ${genAfter})`;
  }
  return noop ? "home-manager switched (no input moved)" : "home-manager switched";
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
  const readlink =
    deps.readlink ??
    ((path: string) => {
      try {
        return readlinkSync(path);
      } catch {
        return null;
      }
    });
  const env = deps.env ?? processEnv();
  const homeDir = deps.homeDir ?? homedir();

  const flakeDir = resolveFlakeDir(options, env, homeDir);
  const requestedInputs = resolveInputNames(options, env);
  const lockPath = resolve(flakeDir, "flake.lock");

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

  const fromRead = readLockRevs(flakeDir, requestedInputs, readFile);
  if (!fromRead.ok) {
    output.error(fromRead.message);
    return fromRead.exitCode;
  }

  // prx-9lc: an input absent from flake.lock is warned-and-skipped so the
  // coupled `prx,ai-home` request degrades gracefully on a flake that
  // legitimately lacks one of the pair. We only hard-fail (exit 2) when NONE of
  // the requested inputs are present — preserving the single `--input <bogus>`
  // → exit 2 behavior.
  for (const name of fromRead.missing) {
    output.error(
      `prx home update: input "${name}" not found in ${lockPath}; skipping`,
    );
  }
  const presentInputs = requestedInputs.filter((n) => fromRead.revs.has(n));
  if (presentInputs.length === 0) {
    const availableText =
      fromRead.available.length > 0 ? fromRead.available.join(", ") : "(none)";
    output.error(
      `prx home update: none of the requested inputs are present in ${lockPath}. Available inputs: ${availableText}`,
    );
    return 2;
  }
  const fromRevs = new Map<string, string | null>();
  for (const name of presentInputs) {
    fromRevs.set(name, fromRead.revs.get(name) ?? null);
  }
  const inputsLabel = presentInputs.join(", ");

  // prx-9lc: `nix flake update a b` updates each named input in one invocation
  // (bare `nix flake update` would update ALL inputs incl. nixpkgs/home-manager
  // — deliberately NOT done, to keep churn scoped to the requested set).
  const nixUpdateCmd = [
    "nix",
    "flake",
    "update",
    ...presentInputs,
    "--flake",
    flakeDir,
  ];
  // prx-1ab: the lockfile commit that keeps the git+file flake tree clean for
  // the switch (run only when `nix flake update` actually moved a rev). The
  // dry-run preview names the requested inputs; the real commit (below) names
  // only the inputs that moved with their rev transitions.
  const gitCommitCmd = ["git", "-C", flakeDir, "commit", "flake.lock", "-m", `chore(flake): update ${inputsLabel}`];
  const hmSwitchCmd = ["home-manager", "switch", "--flake", flakeDir];

  if (options.dryRun) {
    if (options.format === "json") {
      output.log(
        JSON.stringify(
          {
            dryRun: true,
            flakeDir,
            inputs: presentInputs.map((name) => ({
              name,
              from: fromRevs.get(name) ?? null,
            })),
            commands: [nixUpdateCmd, gitCommitCmd, hmSwitchCmd],
          },
          null,
          2,
        ),
      );
    } else {
      output.log(`prx home update (dry-run)`);
      output.log(`  flake:  ${flakeDir}`);
      output.log(`  inputs: ${inputsLabel}`);
      for (const name of presentInputs) {
        output.log(`    ${name}: ${shortRev(fromRevs.get(name) ?? null)}`);
      }
      output.log(`  would run:`);
      output.log(`    ${nixUpdateCmd.join(" ")}`);
      output.log(`    ${gitCommitCmd.join(" ")}   (only if a rev moved)`);
      output.log(`    ${hmSwitchCmd.join(" ")}`);
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
    output.log(`prx home update: ${inputsLabel} @ ${flakeDir}`);
  }

  if (quiet) {
    output.log(
      `  updating flake input${presentInputs.length > 1 ? "s" : ""} ${inputsLabel}…`,
    );
  }
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

  const toRead = readLockRevs(flakeDir, presentInputs, readFile);
  if (!toRead.ok) {
    output.error(toRead.message);
    return toRead.exitCode;
  }
  const toRevs = new Map<string, string | null>();
  for (const name of presentInputs) {
    toRevs.set(name, toRead.revs.get(name) ?? null);
  }
  // prx-9lc: the inputs whose rev actually changed — drives the commit message,
  // the no-op detection, and (only when non-empty) the lockfile commit.
  const moved = presentInputs.filter(
    (name) => (fromRevs.get(name) ?? null) !== (toRevs.get(name) ?? null),
  );

  // prx-1ab: `home-manager switch` evaluates the flake as a `git+file` input and
  // refuses on a dirty tree — and `nix flake update` just dirtied flake.lock.
  // Commit it here so the switch below "just works"; this is the manual step
  // that made updating a multi-command dance. Skipped on a no-op or a non-git
  // flake dir. A commit failure is surfaced (the switch will likely then refuse)
  // but does not abort — the operator sees a precise reason.
  if (moved.length > 0) {
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
      // prx-9lc: name only the moved inputs with their rev transitions, so the
      // commit accurately reflects what the lockfile change did.
      const movedSummary = moved
        .map(
          (name) =>
            `${name} ${shortRev(fromRevs.get(name) ?? null)}→${shortRev(toRevs.get(name) ?? null)}`,
        )
        .join(", ");
      const committed = spawn(
        "git",
        ["-C", flakeDir, "commit", "-m", `chore(flake): update ${movedSummary}`],
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

  // Best-effort generation snapshot around the switch so the summary line can
  // report what the switch actually did (changed vs. already-current).
  const genBefore = readGeneration(readlink, env, homeDir);
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

  const genAfter = readGeneration(readlink, env, homeDir);
  const noop = moved.length === 0;

  if (options.format === "json") {
    output.log(
      JSON.stringify(
        {
          flakeDir,
          inputs: presentInputs.map((name) => {
            const from = fromRevs.get(name) ?? null;
            const to = toRevs.get(name) ?? null;
            return { name, from, to, noop: from === to };
          }),
          switched: true,
        },
        null,
        2,
      ),
    );
  } else {
    for (const name of presentInputs) {
      const from = fromRevs.get(name) ?? null;
      const to = toRevs.get(name) ?? null;
      if (from === to) {
        output.log(`${name}: already up to date (${shortRev(from)})`);
      } else {
        output.log(`${name}: ${shortRev(from)} → ${shortRev(to)}`);
      }
    }
    output.log(switchSummaryLine(noop, genBefore, genAfter));
  }

  return 0;
}
