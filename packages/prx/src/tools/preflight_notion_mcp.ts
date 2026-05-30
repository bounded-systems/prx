/**
 * Notion MCP preflight — verify `claude mcp list` reports a connected `notion` server,
 * then probe `claude --print` to confirm the headless mode can actually reach the
 * server (GH-847: hosted Notion MCP cannot complete OAuth in --print mode).
 *
 * The `NotionClaudeMcpResolver` delegates Notion access to the claude runtime's
 * managed MCP connection. This check fails fast when that connection is missing
 * OR when claude --print would fall into the headless-OAuth trap, before the
 * operator hits the resolver in a session-open path.
 */

import { processEnv } from "@bounded-systems/env";
import { type CommandRunner, defaultRunner } from "../pr-state/github.ts";
import { detectHeadlessOAuthRequired } from "../pr-state/resolvers/notion_claude_mcp.ts";
import { buildNotionPreflightProbeRuntimeProfile } from "../machine/runtime_profiles.ts";
import {
  agentProfileExecutionAsRuntimeResult,
  executeAgentProfile,
} from "../pr-state/executor.ts";

export const NOTION_MCP_SERVER_NAME = "notion";
export const NOTION_MCP_URL = "https://mcp.notion.com/mcp";
export const NOTION_MCP_ADD_COMMAND = `claude mcp add --transport http --scope project ${NOTION_MCP_SERVER_NAME} ${NOTION_MCP_URL}`;

const PROBE_MODEL_DEFAULT = "claude-sonnet-4-6";
const PROBE_PROMPT =
  'Use the registered notion MCP server to call the notion-search tool with query "_prx_preflight". Respond with strict JSON {"ok": true} and nothing else, regardless of whether results were found.';

function probeModel(env: NodeJS.ProcessEnv): string {
  return env.PRX_NOTION_MCP_MODEL ?? PROBE_MODEL_DEFAULT;
}

export type NotionMcpPreflightStatus =
  | "ok"
  | "claude-missing"
  | "notion-mcp-missing"
  | "claude-list-failed"
  | "claude-print-failed"
  | "headless-oauth-required";

export type NotionMcpPreflightResult = {
  ok: boolean;
  status: NotionMcpPreflightStatus;
  detail: string | null;
  remediation: string | null;
};

const HEADLESS_OAUTH_REMEDIATION =
  'claude --print cannot complete Notion OAuth (no token reuse, malformed redirect_uri, no callback listener). ' +
  'Provision a Notion integration token and switch the overlay to `auth = "rest"`, or restrict resolution to GH-* IDs. Tracking: GH-847.';

function hasNotionEntry(stdout: string): boolean {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const firstToken = trimmed.split(/[\s:]/)[0] ?? "";
    if (firstToken.toLowerCase() === NOTION_MCP_SERVER_NAME) {
      return true;
    }
  }
  return false;
}

/**
 * GH-1828: the `claude --print` probe call routes through the Anthropic
 * Agent SDK (`executeAgentProfile`), separate from the `claude mcp list`
 * CLI call that still goes through `CommandRunner`. Tests inject this seam
 * directly (`probeRunner`) instead of stacking two replies into the runner.
 */
export type NotionProbeRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};
export type NotionProbeRunner = (input: {
  model: string;
  prompt: string;
}) => Promise<NotionProbeRunResult>;

export const defaultNotionProbeRunner: NotionProbeRunner = async ({ model, prompt }) => {
  const profile = buildNotionPreflightProbeRuntimeProfile({ model, prompt });
  const dispatched = await executeAgentProfile(profile, {
    cwd: process.cwd(),
    format: "json",
  });
  const collapsed = agentProfileExecutionAsRuntimeResult(dispatched);
  return {
    exitCode: collapsed.status,
    stdout: collapsed.stdout,
    stderr: collapsed.stderr,
  };
};

async function probeHeadlessOAuth(
  probe: NotionProbeRunner,
  env: NodeJS.ProcessEnv,
): Promise<NotionMcpPreflightResult> {
  let result: NotionProbeRunResult;
  try {
    result = await probe({ model: probeModel(env), prompt: PROBE_PROMPT });
  } catch (error) {
    return {
      ok: false,
      status: "claude-print-failed",
      detail: `failed to run claude --print probe: ${(error as Error).message ?? String(error)}`,
      remediation: "Run `prx preflight claude` to check the claude runtime.",
    };
  }
  const oauth =
    detectHeadlessOAuthRequired(result.stderr) ??
    detectHeadlessOAuthRequired(result.stdout);
  if (oauth) {
    return {
      ok: false,
      status: "headless-oauth-required",
      detail: `claude --print emitted Notion OAuth URL (${oauth.authorizeUrl.slice(0, 120)})`,
      remediation: HEADLESS_OAUTH_REMEDIATION,
    };
  }
  if (result.exitCode !== 0) {
    const combined = `${result.stderr.trim()}${result.stderr && result.stdout ? "\n" : ""}${result.stdout.trim()}`;
    return {
      ok: false,
      status: "claude-print-failed",
      detail: `\`claude --print\` probe exited with status ${result.exitCode}: ${combined.slice(0, 300)}`,
      remediation: "Run `prx preflight claude` to check the claude runtime.",
    };
  }
  try {
    JSON.parse(result.stdout);
  } catch (error) {
    return {
      ok: false,
      status: "claude-print-failed",
      detail: `\`claude --print\` probe exited 0 but stdout is not the expected JSON envelope (${(error as Error).message}); first 200 bytes: ${result.stdout.slice(0, 200)}`,
      remediation: "Run `prx preflight claude` to check the claude runtime.",
    };
  }
  return { ok: true, status: "ok", detail: null, remediation: null };
}

export async function runNotionMcpPreflight(
  runner: CommandRunner = defaultRunner,
  env: NodeJS.ProcessEnv = processEnv(),
  probeRunner: NotionProbeRunner = defaultNotionProbeRunner,
): Promise<NotionMcpPreflightResult> {
  let result;
  try {
    result = runner(["claude", "mcp", "list"], { check: false });
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      return {
        ok: false,
        status: "claude-missing",
        detail: "`claude` binary not found on PATH",
        remediation:
          "Install claude via home-manager (programs.claude-runtime.enable = true) or run `prx preflight claude`.",
      };
    }
    return {
      ok: false,
      status: "claude-list-failed",
      detail: `failed to spawn claude: ${(error as Error).message ?? String(error)}`,
      remediation: "Run `prx preflight claude` to check the claude runtime.",
    };
  }
  if (result.status !== 0) {
    const combined = `${result.stderr.trim()}${result.stderr && result.stdout ? "\n" : ""}${result.stdout.trim()}`;
    return {
      ok: false,
      status: "claude-list-failed",
      detail: `\`claude mcp list\` exited with status ${result.status}: ${combined}`,
      remediation: "Run `prx preflight claude` to check the claude runtime.",
    };
  }
  if (!hasNotionEntry(result.stdout)) {
    return {
      ok: false,
      status: "notion-mcp-missing",
      detail: "`claude mcp list` does not include a `notion` server entry",
      remediation: `Add the Notion MCP server: ${NOTION_MCP_ADD_COMMAND}`,
    };
  }
  return probeHeadlessOAuth(probeRunner, env);
}

export function formatNotionMcpPreflight(
  result: NotionMcpPreflightResult,
  format: "plain" | "json",
): string {
  if (format === "json") {
    return JSON.stringify(result);
  }
  if (result.ok) {
    return `notion-mcp preflight: OK (\`${NOTION_MCP_SERVER_NAME}\` server registered with claude and reachable in --print mode)`;
  }
  const lines = [
    "notion-mcp preflight: FAILED",
    `  status: ${result.status}`,
  ];
  if (result.detail) lines.push(`  detail: ${result.detail}`);
  if (result.remediation) lines.push(`  remediation: ${result.remediation}`);
  return lines.join("\n");
}
