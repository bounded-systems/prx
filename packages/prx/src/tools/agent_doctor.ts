import { getEnv } from "@bounded-systems/env";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnCapture } from "@bounded-systems/proc";
import { buildAgentDoctorClaudeProbeRuntimeProfile } from "../machine/runtime_profiles.ts";
import {
  agentProfileExecutionAsRuntimeResult,
  executeAgentProfile,
} from "../pr-state/executor.ts";

export type AgentDoctorName = "claude" | "codex" | "gemini" | "cursor-agent" | "gh-copilot";
export type AgentDoctorErrorType =
  | "auth_error"
  | "quota_error"
  | "permission_error"
  | "config_error"
  | "network_error"
  | "unknown_error";

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  latencyMs: number;
};

type AgentProbeDefinition = {
  name: AgentDoctorName;
  binary: string;
  required: boolean;
  versionCommand: string[];
  pingCommand: string[];
};

export type AgentDoctorResult = {
  agent: AgentDoctorName;
  required: boolean;
  binary: {
    path: string | null;
    sha256: string | null;
  };
  version: {
    command: string[];
    exitCode: number;
    output: string;
  };
  ping: {
    command: string[];
    exitCode: number;
    output: string;
    latencyMs: number;
  };
  healthy: boolean;
  errorType: AgentDoctorErrorType | null;
  helpUrl: string | null;
};

export type AgentDoctorReport = {
  generatedAt: string;
  timeoutMs: number;
  results: AgentDoctorResult[];
};

type AgentDoctorDeps = {
  which: (binary: string) => string | null;
  readBinarySha256: (path: string) => string;
  run: (command: string[], timeoutMs: number) => CommandResult;
  /**
   * GH-1828: the claude probe routes through the Anthropic Agent SDK
   * (`executeAgentProfile`) rather than `deps.run`. Defaults to the
   * SDK-backed runner; tests inject a fake for deterministic behavior.
   * The version check (`claude --version`) stays on `deps.run` — it's a
   * pure CLI invocation, not an agent invocation.
   */
  runClaudeProbe?: (input: {
    model: string;
    prompt: string;
    timeoutMs: number;
  }) => Promise<CommandResult>;
};

const defaultClaudeProbeRunner: NonNullable<AgentDoctorDeps["runClaudeProbe"]> = async ({
  model,
  prompt,
  timeoutMs,
}) => {
  const startedAt = Date.now();
  const profile = buildAgentDoctorClaudeProbeRuntimeProfile({ model, prompt });
  const dispatched = await executeAgentProfile(profile, {
    cwd: process.cwd(),
    format: "json",
    timeoutMs,
  });
  const collapsed = agentProfileExecutionAsRuntimeResult(dispatched);
  return {
    exitCode: collapsed.status,
    stdout: collapsed.stdout,
    stderr: collapsed.stderr,
    latencyMs: Date.now() - startedAt,
  };
};

const defaultDeps: AgentDoctorDeps = {
  which: (binary) => Bun.which(binary) ?? null,
  readBinarySha256: (path) => createHash("sha256").update(readFileSync(path)).digest("hex"),
  runClaudeProbe: defaultClaudeProbeRunner,
  run: (command, timeoutMs) => {
    const startedAt = Date.now();
    // GH-1609: route through spawnCapture so a verbose probe (e.g. a
    // `--print --output-format json` agent response) cannot hit the default
    // 1 MiB stdout cap and surface its partial bytes here.
    const result = spawnCapture(command, { timeout: timeoutMs });
    const latencyMs = Date.now() - startedAt;
    let stdout = result.stdout;
    let stderr = result.stderr;
    let exitCode: number;
    if (result.error) {
      const error = result.error as NodeJS.ErrnoException;
      if (error.code === "ETIMEDOUT") {
        exitCode = 124;
        stderr = stderr || "timed out";
      } else {
        exitCode = 1;
        stderr = stderr || error.message || String(error);
      }
    } else if (result.signal) {
      exitCode = 128;
      stderr = stderr || `terminated by signal ${result.signal}`;
    } else {
      exitCode = result.status ?? 1;
    }
    return {
      exitCode,
      stdout,
      stderr,
      latencyMs,
    };
  },
};

function outputText(result: CommandResult): string {
  const text = (result.stdout || result.stderr).trim();
  return text.length > 0 ? text : "(no output)";
}

function truncate(text: string, max = 300): string {
  const compact = text.replace(/\r\n/g, "\n").trim();
  if (compact.length <= max) {
    return compact;
  }
  return `${compact.slice(0, max)}...`;
}

function probeDefinitions(): AgentProbeDefinition[] {
  const geminiModel = getEnv("PRX_DOCTOR_MODEL_GEMINI");
  return [
    {
      name: "claude",
      binary: "claude",
      required: true,
      versionCommand: ["claude", "--version"],
      pingCommand: [
        "claude",
        "--print",
        "--permission-mode",
        "dontAsk",
        "--model",
        getEnv("PRX_DOCTOR_MODEL_CLAUDE") ?? "claude-sonnet-4-6",
        "--output-format",
        "json",
        "respond with OK",
      ],
    },
    {
      name: "codex",
      binary: "codex",
      required: true,
      versionCommand: ["codex", "--version"],
      pingCommand: [
        "codex",
        "exec",
        "-m",
        getEnv("PRX_DOCTOR_MODEL_CODEX") ?? "gpt-5",
        "respond with OK",
      ],
    },
    {
      name: "gemini",
      binary: "gemini",
      required: true,
      versionCommand: ["gemini", "--version"],
      pingCommand: [
        "gemini",
        "-p",
        "respond with OK",
        ...(geminiModel ? ["--model", geminiModel] : []),
        "--output-format",
        "json",
      ],
    },
    {
      name: "cursor-agent",
      binary: "cursor-agent",
      required: true,
      versionCommand: ["cursor-agent", "--version"],
      pingCommand: [
        "cursor-agent",
        "--print",
        "--model",
        getEnv("PRX_DOCTOR_MODEL_CURSOR") ?? "auto",
        "--output-format",
        "json",
        "respond with OK",
      ],
    },
    {
      name: "gh-copilot",
      binary: "gh",
      required: false,
      versionCommand: ["gh", "--version"],
      pingCommand: ["gh", "copilot", "--", "-p", "respond with OK"],
    },
  ];
}

const helpUrls: Record<AgentDoctorName, Partial<Record<AgentDoctorErrorType, string>>> = {
  claude: {
    auth_error: "https://console.anthropic.com/settings/keys",
    quota_error: "https://console.anthropic.com/settings/billing",
    permission_error: "https://docs.anthropic.com/claude-code",
    config_error: "https://docs.anthropic.com/claude-code",
  },
  codex: {
    auth_error: "https://platform.openai.com/api-keys",
    quota_error: "https://platform.openai.com/usage",
    config_error: "https://platform.openai.com/docs",
  },
  gemini: {
    auth_error: "https://aistudio.google.com/app/apikey",
    quota_error: "https://console.cloud.google.com/apis/api/generativelanguage.googleapis.com/quotas",
    config_error: "https://ai.google.dev/gemini-api/docs",
  },
  "cursor-agent": {
    auth_error: "https://cursor.sh/settings",
    quota_error: "https://cursor.sh/settings/billing",
    config_error: "https://docs.cursor.com/cli/reference",
  },
  "gh-copilot": {
    auth_error: "https://github.com/settings/tokens",
    quota_error: "https://github.com/settings/copilot",
    config_error: "https://github.com/settings/copilot",
  },
};

function classifyError(output: string): AgentDoctorErrorType {
  const text = output.toLowerCase();
  if (/\b402\b/.test(text) || text.includes("quota") || text.includes("billing") || /\b429\b/.test(text)) {
    return "quota_error";
  }
  if (/\b401\b/.test(text) || text.includes("unauthorized") || text.includes("invalid api key") || text.includes("auth")) {
    return "auth_error";
  }
  if (text.includes("permission") || text.includes("approval") || text.includes("sandbox")) {
    return "permission_error";
  }
  if (text.includes("modelnotfound") || text.includes("cannot use this model") || text.includes("unknown model") || text.includes("not found")) {
    return "config_error";
  }
  if (text.includes("network") || text.includes("econn") || text.includes("timed out") || text.includes("dns")) {
    return "network_error";
  }
  return "unknown_error";
}

function helpUrlFor(agent: AgentDoctorName, errorType: AgentDoctorErrorType): string | null {
  return helpUrls[agent][errorType] ?? null;
}

export async function runAgentDoctor(
  input: {
    timeoutMs?: number | undefined;
    agents?: AgentDoctorName[] | undefined;
  } = {},
  deps: AgentDoctorDeps = defaultDeps,
): Promise<AgentDoctorReport> {
  const timeoutMs = input.timeoutMs ?? 15000;
  const selected = new Set(input.agents ?? probeDefinitions().map((probe) => probe.name));
  const results: AgentDoctorResult[] = [];
  // GH-1828: the claude probe routes through `runClaudeProbe` (SDK-backed
  // by default); other agents stay on `deps.run`.
  const runClaudeProbe = deps.runClaudeProbe ?? defaultClaudeProbeRunner;
  const claudeProbeModel = getEnv("PRX_DOCTOR_MODEL_CLAUDE") ?? "claude-sonnet-4-6";
  const claudeProbePrompt = "respond with OK";

  for (const probe of probeDefinitions()) {
    if (!selected.has(probe.name)) {
      continue;
    }
    const binaryPath = deps.which(probe.binary);
    let binarySha: string | null = null;
    if (binaryPath) {
      try {
        binarySha = deps.readBinarySha256(binaryPath);
      } catch {
        binarySha = null;
      }
    }
    if (!binaryPath) {
      results.push({
        agent: probe.name,
        required: probe.required,
        binary: { path: null, sha256: null },
        version: { command: probe.versionCommand, exitCode: 127, output: "command not found" },
        ping: { command: probe.pingCommand, exitCode: 127, output: "command not found", latencyMs: 0 },
        healthy: false,
        errorType: "config_error",
        helpUrl: helpUrlFor(probe.name, "config_error"),
      });
      continue;
    }
    const version = deps.run(probe.versionCommand, timeoutMs);
    const ping = probe.name === "claude"
      ? await runClaudeProbe({ model: claudeProbeModel, prompt: claudeProbePrompt, timeoutMs })
      : deps.run(probe.pingCommand, timeoutMs);
    const healthy = version.exitCode === 0 && ping.exitCode === 0 && outputText(ping) !== "(no output)";
    const errorType = healthy ? null : classifyError(outputText(ping));
    results.push({
      agent: probe.name,
      required: probe.required,
      binary: {
        path: binaryPath,
        sha256: binarySha,
      },
      version: {
        command: probe.versionCommand,
        exitCode: version.exitCode,
        output: truncate(outputText(version)),
      },
      ping: {
        command: probe.pingCommand,
        exitCode: ping.exitCode,
        output: truncate(outputText(ping)),
        latencyMs: ping.latencyMs,
      },
      healthy,
      errorType,
      helpUrl: errorType ? helpUrlFor(probe.name, errorType) : null,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    timeoutMs,
    results,
  };
}

export function renderAgentDoctorPlain(report: AgentDoctorReport): string {
  const lines: string[] = [];
  lines.push(`agent-doctor generated_at=${report.generatedAt} timeout_ms=${report.timeoutMs}`);
  for (const result of report.results) {
    lines.push(
      `${result.agent}: ${result.healthy ? "healthy" : "unhealthy"} required=${result.required ? "yes" : "no"} version_exit=${result.version.exitCode} ping_exit=${result.ping.exitCode} latency_ms=${result.ping.latencyMs}`,
    );
    lines.push(`  version: ${result.version.output}`);
    lines.push(`  ping: ${result.ping.output}`);
    if (result.errorType) {
      lines.push(`  error: ${result.errorType}`);
    }
    if (result.helpUrl) {
      lines.push(`  fix: ${result.helpUrl}`);
    }
  }
  return lines.join("\n");
}
