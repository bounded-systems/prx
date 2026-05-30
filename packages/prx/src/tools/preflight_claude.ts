/**
 * Claude Code preflight — verify LSP dependencies are on PATH.
 *
 * Claude Code detects LSP binaries on PATH at startup. When they're missing
 * it falls into an interactive install prompt, which breaks non-interactive
 * flows (CI, prx wrappers, fresh shells). This check satisfies the detection
 * condition ahead of time and fails fast when it isn't met.
 *
 * Replaces scripts/claude-preflight (GH-615).
 */

import { localProcExecutor } from "@bounded-systems/proc";

const proc = localProcExecutor();

export const REQUIRED_BINARIES = ["typescript-language-server", "tsserver"] as const;

export type ClaudePreflightResult = {
  ok: boolean;
  missing: string[];
  resolved: Record<string, string>;
};

async function resolveOnPath(binary: string): Promise<string | null> {
  // `command -v` is a shell builtin; run it through /bin/sh. The binary names
  // are fixed constants (REQUIRED_BINARIES), so the interpolation is safe.
  const result = await proc.exec({
    command: "/bin/sh",
    args: ["-c", `command -v ${binary}`],
  });
  if (result.status !== 0) return null;
  const out = result.stdout.trim();
  return out.length > 0 ? out : null;
}

export async function runClaudePreflight(): Promise<ClaudePreflightResult> {
  const resolved: Record<string, string> = {};
  const missing: string[] = [];
  for (const bin of REQUIRED_BINARIES) {
    const path = await resolveOnPath(bin);
    if (path) {
      resolved[bin] = path;
    } else {
      missing.push(bin);
    }
  }
  return { ok: missing.length === 0, missing, resolved };
}

export function formatClaudePreflight(
  result: ClaudePreflightResult,
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(result);
  }
  if (result.ok) {
    return [
      "claude preflight: OK",
      ...REQUIRED_BINARIES.map((bin) => `  ${bin} -> ${result.resolved[bin]}`),
    ].join("\n");
  }
  return [
    "claude preflight: missing required binaries on PATH:",
    ...result.missing.map((bin) => `  - ${bin}`),
    "",
    "Install via home-manager (programs.claude-runtime.enable = true)",
    "or globally: npm i -g typescript typescript-language-server",
  ].join("\n");
}
