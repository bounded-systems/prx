import type { SessionEntryEvent } from "../../machine/machines/session-entry.ts";
import { parseRepoFlag } from "../repo-flag.ts";
import { parseSourceFlag } from "../source-flag.ts";

/**
 * GH-2014: typed refusal carrier so the upstream cli dispatch path can
 * route this to its standard `handleRunCliError` rather than crashing
 * with a stack trace. Defined locally to keep `event-for-argv` cycle-free
 * with `cli.ts` (which is the only other home for `CliError`).
 */
export class SessionEntryArgvError extends Error {}

/**
 * GH-977: pure argv → SessionEntryEvent mapping.
 *
 * This is the **single home for the session-entry alias rule**. Both
 * `prx session open <id>` and `prx plan session <id>` produce the same
 * `OPEN_PLAN_SESSION` event; only the alias path sets `viaAlias: true` so
 * the machine's `emitStderrHint` action emits the deprecation hint.
 *
 * Adding the next deprecation alias is one new line here plus zero changes
 * to `sessionEntryMachine`.
 *
 * GH-1661: `--repo <name>` (or `--repo=<name>`) on `plan session` and
 * `session open` is parsed via {@link parseRepoFlag} and threaded onto
 * the emitted event as `repoCtx.repo`. The flag may appear before or
 * after the positional work-unit id.
 *
 * GH-2014: `--background` (boolean) emits `attachMode: "background"` on
 * `OPEN_PLAN_SESSION`. `--detached` is a named refusal pointing at
 * `--background` to avoid the git-detached-HEAD vocabulary collision
 * flagged in GH-1983.
 */
export const PRX_BACKGROUND_DETACHED_REFUSAL =
  "--detached is not supported here (avoids the git detached-HEAD collision flagged in GH-1983); use --background to boot the session without attaching.";

function parseBackgroundFlag(args: readonly string[]): {
  attachMode: "foreground" | "background";
  remainder: string[];
} {
  if (args.includes("--detached") || args.includes("--detached=true")) {
    throw new SessionEntryArgvError(PRX_BACKGROUND_DETACHED_REFUSAL);
  }
  const remainder: string[] = [];
  let background = false;
  for (const a of args) {
    if (a === "--background") {
      background = true;
      continue;
    }
    remainder.push(a);
  }
  return { attachMode: background ? "background" : "foreground", remainder };
}

export function eventForArgv(argv: readonly string[]): SessionEntryEvent | null {
  const a0 = argv[0];
  const a1 = argv[1];
  const rest = argv.slice(2);

  if (a0 === "plan" && a1 === "session") {
    const { attachMode, remainder: afterBg } = parseBackgroundFlag(rest);
    const { repo, remainder: afterRepo } = parseRepoFlag(afterBg);
    const { source, remainder } = parseSourceFlag(afterRepo);
    const id = remainder[0];
    if (typeof id !== "string" || id.length === 0) return null;
    return {
      type: "OPEN_PLAN_SESSION",
      workUnitId: id,
      ...(repo !== undefined ? { repoCtx: { repo } } : {}),
      ...(source !== undefined ? { sourceCtx: { source } } : {}),
      ...(attachMode === "background" ? { attachMode } : {}),
    };
  }
  if (a0 === "session" && a1 === "open") {
    const { attachMode, remainder: afterBg } = parseBackgroundFlag(rest);
    const { repo, remainder: afterRepo } = parseRepoFlag(afterBg);
    const { source, remainder } = parseSourceFlag(afterRepo);
    const id = remainder[0];
    if (typeof id !== "string" || id.length === 0) return null;
    return {
      type: "OPEN_PLAN_SESSION",
      workUnitId: id,
      viaAlias: true,
      ...(repo !== undefined ? { repoCtx: { repo } } : {}),
      ...(source !== undefined ? { sourceCtx: { source } } : {}),
      ...(attachMode === "background" ? { attachMode } : {}),
    };
  }
  // GH-2380: the four ops profiles use the canonical `agent` verb (headless-
  // first). `--interactive` selects the legacy tmux/PTY profile; its absence
  // means the default headless SDK profile. The hard-removed `session` token
  // is rejected upstream at the parser, so it never reaches here.
  if (a0 === "intake" && a1 === "agent") {
    const { interactive, remainder } = parseInteractiveFlag(rest);
    // prx-28w: `--message "…"` seeds the intake operator at one specific item.
    const { message } = parseMessageFlag(remainder);
    return {
      type: "OPEN_INTAKE_SESSION",
      ...(interactive ? { interaction: "interactive" as const } : {}),
      ...(message ? { message } : {}),
    };
  }
  if (a0 === "triage" && a1 === "agent") {
    const { interactive, remainder } = parseInteractiveFlag(rest);
    // prx-383: an optional positional work-unit id seeds triage at that item.
    const unit = remainder.find((a) => !a.startsWith("-"));
    return {
      type: "OPEN_TRIAGE_SESSION",
      ...(interactive ? { interaction: "interactive" as const } : {}),
      ...(unit ? { message: unit } : {}),
    };
  }
  if (a0 === "submit" && a1 === "agent") {
    // GH-1900: submit is work-unit-bound; require a positional id.
    // Parser rejects the no-positional form upstream.
    const { interactive, remainder } = parseInteractiveFlag(rest);
    const id = remainder[0];
    if (typeof id !== "string" || id.length === 0) return null;
    return {
      type: "OPEN_SUBMIT_SESSION",
      workUnitId: id,
      ...(interactive ? { interaction: "interactive" as const } : {}),
    };
  }
  if (a0 === "author" && a1 === "agent") {
    const { interactive, remainder } = parseInteractiveFlag(rest);
    const id = remainder[0];
    if (typeof id !== "string" || id.length === 0) return null;
    return {
      type: "OPEN_AUTHOR_SESSION",
      workUnitId: id,
      ...(interactive ? { interaction: "interactive" as const } : {}),
    };
  }
  return null;
}

/**
 * GH-2380: strip `--interactive` from the argv tail. The flag's presence
 * selects the legacy tmux/PTY profile; absence is the headless-first default.
 */
function parseInteractiveFlag(args: readonly string[]): {
  interactive: boolean;
  remainder: string[];
} {
  const remainder: string[] = [];
  let interactive = false;
  for (const a of args) {
    if (a === "--interactive" || a === "--interactive=true") {
      interactive = true;
      continue;
    }
    remainder.push(a);
  }
  return { interactive, remainder };
}

/**
 * prx-28w: extract `--message <value>` / `--message=<value>` from the argv tail.
 * The seed aims `prx intake agent` at one specific item instead of a sweep.
 */
function parseMessageFlag(args: readonly string[]): {
  message: string | undefined;
  remainder: string[];
} {
  const remainder: string[] = [];
  let message: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--message") {
      message = args[i + 1];
      i += 1; // consume the value
      continue;
    }
    if (a !== undefined && a.startsWith("--message=")) {
      message = a.slice("--message=".length);
      continue;
    }
    if (a !== undefined) remainder.push(a);
  }
  return { message, remainder };
}
