import { spawnCapture } from "@bounded-systems/proc";

/**
 * GH-1287: capability detection for the local `claude` CLI. Centralises the
 * one question the implement-session runtime profile needs to answer before
 * choosing how to deliver the system prompt: does this `claude` binary accept
 * `--append-system-prompt-file <path>`?
 *
 * The flag landed in the `claude` CLI but is only documented inline in the
 * `--bare` description (`--append-system-prompt[-file]`), not as a separate
 * `--help` entry. Detection greps the full `--help` output for either form so
 * the check survives both the explicit and bracketed help shapes.
 *
 * Memoised at module scope: the help output is stable for the lifetime of the
 * process, so the spawn fires at most once per `prx implement` invocation.
 */

let memoized: boolean | undefined;

export function claudeSupportsSystemPromptFile(): boolean {
  if (memoized !== undefined) return memoized;
  memoized = probeClaudeSystemPromptFileFlag();
  return memoized;
}

function probeClaudeSystemPromptFileFlag(): boolean {
  try {
    const result = spawnCapture(["claude", "--help"], { timeout: 5000 });
    if (result.error) return false;
    if (result.status !== 0 && !result.stdout) return false;
    const text = `${result.stdout}\n${result.stderr}`;
    return /--append-system-prompt(-file|\[-file\])/.test(text);
  } catch {
    return false;
  }
}

export function __setClaudeSystemPromptFileSupportForTests(value: boolean | undefined): void {
  memoized = value;
}

export function __resetClaudeCapabilitiesForTests(): void {
  memoized = undefined;
}
