/**
 * GH-838: reconcile live tmux server options against the rendered home-manager
 * tmux config. Lives next to dolt-reconcile in the parity-chain family of
 * verbs — same vocabulary (authority, mode, dry-run vs apply, idempotent
 * re-run), kept in its own module so the existing branch/PR/worktree parity
 * chain in `github.ts` stays untouched. A future PR can fold this into the
 * unified SurfaceSyncAction union; the shapes here are intentionally
 * compatible (action-per-row, command string, summary).
 *
 * Source of truth: rendered `~/.config/tmux/tmux.conf` (post `home-manager
 * switch`). The parser walks the file every run — there is no hand-maintained
 * option list here, so adding a new `programs.tmux` knob in
 * `nix/home-manager/tmux-prx.nix` automatically participates in reconcile.
 *
 * Scope (this PR): scalar `set -g` / `setw -g` global options on the prx
 * socket. `set-hook`, `run-shell`, `bind-key`, `source-file`, plugin lines,
 * and `@`-prefixed user options (`@pane-name`, `@resurrect-dir`,
 * `@prx-resurrect-script`, …) are surfaced as `unsupported` warnings, never
 * applied — they need either a server restart or are owned by the prx-mux
 * driver / plugins, not by config drift.
 */

import { processEnv } from "@bounded-systems/env";
import { spawnCapture } from "@bounded-systems/proc";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export type TmuxReconcileSpawnResult = {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: Error;
};

export type TmuxReconcileSpawn = (
  file: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv },
) => TmuxReconcileSpawnResult;

export type TmuxReconcileDeps = {
  spawn?: TmuxReconcileSpawn;
  readFile?: (path: string) => string;
  pathExists?: (path: string) => boolean;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

export type TmuxReconcileOptions = {
  socket: string;
  configPath?: string | undefined;
  dryRun: boolean;
  format: "plain" | "json";
};

export type TmuxOptionDelta = {
  option: string;
  scope: "global" | "window";
  from: string;
  to: string;
  command: string;
};

export type TmuxAppliedDelta = TmuxOptionDelta & {
  status: "applied" | "would-apply" | "failed";
  exitCode?: number;
  stderrTail?: string;
};

export type TmuxUnsupportedLine = {
  kind: "hook" | "plugin" | "bind" | "source-file" | "user-option" | "unparseable";
  line: string;
  raw: string;
};

export type TmuxReconcileResult = {
  socket: string;
  serverRunning: boolean;
  configPath: string;
  checked: number;
  applied: TmuxAppliedDelta[];
  unsupported: TmuxUnsupportedLine[];
  inSync: boolean;
  errors: string[];
};

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

type ParsedConfig = {
  options: Map<string, { scope: "global" | "window"; value: string }>;
  unsupported: TmuxUnsupportedLine[];
};

const HOOK_DIRECTIVES = new Set(["set-hook", "run-shell", "run", "source-file"]);
const BIND_DIRECTIVES = new Set(["bind", "bind-key", "unbind", "unbind-key"]);

function defaultConfigPath(homeDir: string, env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : resolve(homeDir, ".config");
  return resolve(base, "tmux", "tmux.conf");
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "'" || first === '"') && first === last) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function stripTrailingComment(rest: string): string {
  // tmux comments begin with `#` only at column 0 or after whitespace; this
  // matches the rendered home-manager output (we never have inline-quoted `#`
  // in scalar values for the options we manage).
  let out = rest;
  const hashIdx = out.search(/\s#/);
  if (hashIdx >= 0) out = out.slice(0, hashIdx);
  return out.trimEnd();
}

/**
 * Parse a rendered tmux.conf for managed scalar options. Returns the option
 * map plus an `unsupported` list of lines we deliberately do not reconcile
 * (hooks, plugins, bindings, user options).
 *
 * The parser is line-oriented and intentionally lenient — unknown directives
 * are silently skipped (not warned) so an extension to home-manager elsewhere
 * does not flood reconcile with noise. Only categories we explicitly know
 * about and need to warn the operator about (hooks/plugins) are tagged.
 */
export function parseTmuxConfig(text: string): ParsedConfig {
  const options = new Map<string, { scope: "global" | "window"; value: string }>();
  const unsupported: TmuxUnsupportedLine[] = [];

  const rawLines = text.split(/\r?\n/);

  // Fold backslash continuations.
  const lines: string[] = [];
  let buffer = "";
  for (const raw of rawLines) {
    const trimmedEnd = raw.replace(/\s+$/, "");
    if (trimmedEnd.endsWith("\\")) {
      buffer += `${trimmedEnd.slice(0, -1)} `;
      continue;
    }
    lines.push(buffer + raw);
    buffer = "";
  }
  if (buffer.length > 0) lines.push(buffer);

  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    if (line.length === 0) continue;
    if (line.startsWith("#")) continue;

    const firstSpace = line.search(/\s/);
    const head = firstSpace < 0 ? line : line.slice(0, firstSpace);
    const tail = firstSpace < 0 ? "" : line.slice(firstSpace + 1);

    if (HOOK_DIRECTIVES.has(head)) {
      unsupported.push({ kind: head === "source-file" ? "source-file" : head === "set-hook" ? "hook" : "plugin", line, raw: lineRaw });
      continue;
    }
    if (BIND_DIRECTIVES.has(head)) {
      unsupported.push({ kind: "bind", line, raw: lineRaw });
      continue;
    }

    if (head !== "set" && head !== "set-option" && head !== "setw" && head !== "set-window-option") {
      continue;
    }

    let scope: "global" | "window" =
      head === "setw" || head === "set-window-option" ? "window" : "global";

    // Tokens after the directive: `[-g] [-q] [-u] <option> <value...>`. tmux
    // also accepts combined flags like `-gu` (global + unset) or `-ga`
    // (global + append). For safety we only reconcile lines whose flag set is
    // exactly {g} or {g,q} — anything that mutates semantics (u/a/F/o) marks
    // the line unparseable so we skip it without trying to derive a value.
    const tokens = tail.split(/\s+/).filter((t) => t.length > 0);
    let i = 0;
    let isGlobal = false;
    let semanticFlag = false;
    // `i < tokens.length` guarantees tokens[i] is in-bounds.
    while (i < tokens.length && tokens[i]!.startsWith("-") && tokens[i]!.length > 1) {
      const flagToken = tokens[i]!.slice(1);
      for (const ch of flagToken) {
        if (ch === "g") isGlobal = true;
        else if (ch === "q") {
          /* quiet, ignore */
        } else if (ch === "u" || ch === "a" || ch === "F" || ch === "o") semanticFlag = true;
        else if (ch === "w") {
          scope = "window";
        } else {
          // Unknown flag (e.g. -p pane scope, -s server scope, -F format).
          semanticFlag = true;
        }
      }
      i += 1;
    }
    if (semanticFlag) {
      unsupported.push({ kind: "unparseable", line, raw: lineRaw });
      continue;
    }
    if (!isGlobal && scope === "global") {
      // `set <opt> <val>` without -g sets a session-local option; skip — the
      // managed config in tmux-prx.nix uses `set -g` for everything we care
      // about here.
      continue;
    }

    if (i >= tokens.length) {
      unsupported.push({ kind: "unparseable", line, raw: lineRaw });
      continue;
    }
    // `i >= tokens.length` is guarded above, so tokens[i] is in-bounds.
    const option = tokens[i]!;
    const valueRaw = tokens.slice(i + 1).join(" ");

    if (option.startsWith("@")) {
      unsupported.push({ kind: "user-option", line, raw: lineRaw });
      continue;
    }
    if (valueRaw.length === 0) {
      unsupported.push({ kind: "unparseable", line, raw: lineRaw });
      continue;
    }

    const value = stripQuotes(stripTrailingComment(valueRaw));
    options.set(option, { scope, value });
  }

  return { options, unsupported };
}

function tmuxArgs(socket: string, ...rest: string[]): string[] {
  return ["-L", socket, ...rest];
}

function asString(value: string | Buffer | null | undefined): string {
  if (value == null) return "";
  return typeof value === "string" ? value : value.toString("utf8");
}

function tail(text: string, maxLines = 3): string {
  const trimmed = text.replace(/\s+$/, "");
  if (trimmed.length === 0) return "";
  return trimmed.split(/\r?\n/).slice(-maxLines).join("\n");
}

/**
 * Query a single global option's current value on the live socket.
 * Uses `show-option -gqv`: `-q` suppresses errors for unset, `-v` prints
 * just the raw value (one line, no `<opt> <val>` prefix).
 */
function showLiveOption(
  spawn: TmuxReconcileSpawn,
  socket: string,
  option: string,
  scope: "global" | "window",
  env: NodeJS.ProcessEnv,
): { ok: true; value: string } | { ok: false; stderr: string } {
  const flag = scope === "window" ? "-gwqv" : "-gqv";
  const result = spawn("tmux", tmuxArgs(socket, "show-option", flag, option), { env });
  if (result.error) {
    return { ok: false, stderr: result.error.message };
  }
  if ((result.status ?? 0) !== 0) {
    return { ok: false, stderr: tail(asString(result.stderr)) };
  }
  return { ok: true, value: asString(result.stdout).replace(/\n+$/, "") };
}

function commandFor(socket: string, option: string, scope: "global" | "window", value: string): string {
  const directive = scope === "window" ? "setw -g" : "set -g";
  // Quote values containing whitespace; the options we manage today are all
  // single tokens (on/off/0/1/numeric/identifier) but be defensive.
  const quoted = /\s/.test(value) ? `'${value}'` : value;
  return `tmux -L ${socket} ${directive} ${option} ${quoted}`;
}

function applyOption(
  spawn: TmuxReconcileSpawn,
  socket: string,
  delta: TmuxOptionDelta,
  env: NodeJS.ProcessEnv,
): TmuxAppliedDelta {
  const flag = delta.scope === "window" ? "-gw" : "-g";
  const result = spawn(
    "tmux",
    tmuxArgs(socket, "set-option", flag, delta.option, delta.to),
    { env },
  );
  if (result.error) {
    return { ...delta, status: "failed", exitCode: 1, stderrTail: result.error.message };
  }
  const exitCode = result.status ?? 1;
  if (exitCode !== 0) {
    return { ...delta, status: "failed", exitCode, stderrTail: tail(asString(result.stderr)) };
  }
  return { ...delta, status: "applied", exitCode: 0 };
}

/**
 * Compute the reconcile result without printing or returning an exit code.
 * Used by `prx home update` to embed reconcile output in the same JSON
 * payload after the home-manager switch (avoids two stdout payloads).
 *
 * Returns the result plus a recommended `exitCode` so callers that *do* want
 * one (the standalone CLI) can use it directly.
 */
export function computeTmuxReconcile(
  options: TmuxReconcileOptions,
  deps: TmuxReconcileDeps = {},
): { result: TmuxReconcileResult; exitCode: number } {
  const spawn: TmuxReconcileSpawn =
    deps.spawn ?? ((file, args, opts): TmuxReconcileSpawnResult => {
      const r = spawnCapture([file, ...args], opts);
      return {
        status: r.status,
        stdout: r.stdout,
        stderr: r.stderr,
        ...(r.error ? { error: r.error } : {}),
      };
    });
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const pathExists = deps.pathExists ?? ((path: string) => existsSync(path));
  const env = deps.env ?? processEnv();
  const homeDir = deps.homeDir ?? homedir();

  const configPath = options.configPath ?? defaultConfigPath(homeDir, env);

  if (!pathExists(configPath)) {
    return {
      result: {
        socket: options.socket,
        serverRunning: false,
        configPath,
        checked: 0,
        applied: [],
        unsupported: [],
        inSync: false,
        errors: [`tmux.conf not found at ${configPath}`],
      },
      exitCode: 2,
    };
  }

  let parsed: ParsedConfig;
  try {
    parsed = parseTmuxConfig(readFile(configPath));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      result: {
        socket: options.socket,
        serverRunning: false,
        configPath,
        checked: 0,
        applied: [],
        unsupported: [],
        inSync: false,
        errors: [`failed to read ${configPath}: ${message}`],
      },
      exitCode: 2,
    };
  }

  // Probe the live server. `has-session` exits 1 when no session is running
  // on the socket, which for a long-lived prx server effectively means "no
  // server" — there is always at least one session if the server is up.
  const probe = spawn("tmux", tmuxArgs(options.socket, "has-session"), { env });
  if (probe.error) {
    return {
      result: {
        socket: options.socket,
        serverRunning: false,
        configPath,
        checked: 0,
        applied: [],
        unsupported: parsed.unsupported,
        inSync: false,
        errors: [`tmux invocation failed: ${probe.error.message}`],
      },
      exitCode: 1,
    };
  }
  const serverRunning = (probe.status ?? 1) === 0;

  if (!serverRunning) {
    return {
      result: {
        socket: options.socket,
        serverRunning: false,
        configPath,
        checked: 0,
        applied: [],
        unsupported: parsed.unsupported,
        inSync: true,
        errors: [],
      },
      exitCode: 0,
    };
  }

  const deltas: TmuxOptionDelta[] = [];
  const errors: string[] = [];
  const optionEntries = Array.from(parsed.options.entries()).sort(([a], [b]) => a.localeCompare(b));

  for (const [option, { scope, value }] of optionEntries) {
    const live = showLiveOption(spawn, options.socket, option, scope, env);
    if (!live.ok) {
      errors.push(`show-option ${option}: ${live.stderr}`);
      continue;
    }
    if (live.value === value) continue;
    deltas.push({
      option,
      scope,
      from: live.value.length > 0 ? live.value : "(unset)",
      to: value,
      command: commandFor(options.socket, option, scope, value),
    });
  }

  let applied: TmuxAppliedDelta[];
  let exitCode = 0;
  if (options.dryRun) {
    applied = deltas.map((d) => ({ ...d, status: "would-apply", exitCode: 0 }));
  } else {
    applied = deltas.map((d) => applyOption(spawn, options.socket, d, env));
    if (applied.some((a) => a.status === "failed")) exitCode = 1;
  }
  if (errors.length > 0) exitCode = 1;

  return {
    result: {
      socket: options.socket,
      serverRunning: true,
      configPath,
      checked: optionEntries.length,
      applied,
      unsupported: parsed.unsupported,
      inSync: applied.length === 0 && errors.length === 0,
      errors,
    },
    exitCode,
  };
}

export function runTmuxReconcile(
  options: TmuxReconcileOptions,
  output: Output,
  deps: TmuxReconcileDeps = {},
): number {
  const { result, exitCode } = computeTmuxReconcile(options, deps);
  output.log(formatTmuxReconcile(result, options.format, options.dryRun));
  return exitCode;
}

export function formatTmuxReconcile(
  result: TmuxReconcileResult,
  format: "plain" | "json",
  dryRun: boolean,
): string {
  if (format === "json") {
    return JSON.stringify({ dryRun, ...result }, null, 2);
  }

  const lines: string[] = [];
  lines.push(dryRun ? "prx tmux reconcile (dry-run):" : "prx tmux reconcile:");

  if (result.errors.length === 0 && !result.serverRunning) {
    lines.push(`  ${result.socket}: server not running, nothing to reconcile`);
    if (result.unsupported.length > 0) {
      lines.push(`  note: ${result.unsupported.length} hook/plugin/user-option line(s) skipped (server restart required to apply)`);
    }
    return lines.join("\n");
  }

  if (result.errors.length > 0) {
    for (const err of result.errors) lines.push(`  error: ${err}`);
  }

  if (result.inSync) {
    lines.push(`  ${result.socket}: in sync (${result.checked} option${result.checked === 1 ? "" : "s"} checked)`);
  } else {
    const verb = dryRun ? "would apply" : "applied";
    lines.push(`  ${result.socket}: ${result.applied.length} ${verb}`);
    for (const a of result.applied) {
      const arrow = `${a.from}→${a.to}`;
      if (a.status === "failed") {
        lines.push(`    ${a.option}: ${arrow} FAILED (exit ${a.exitCode ?? "?"})`);
      } else {
        lines.push(`    ${a.option}: ${arrow}`);
      }
    }
  }

  if (result.unsupported.length > 0) {
    lines.push(`  note: ${result.unsupported.length} hook/plugin/user-option line(s) skipped (server restart required to apply)`);
  }
  return lines.join("\n");
}
