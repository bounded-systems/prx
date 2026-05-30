#!/usr/bin/env bun
import { parseArgs } from "node:util";

import {
  renderAgentDoctorPlain,
  runAgentDoctor,
  type AgentDoctorName,
} from "../src/tools/agent_doctor.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    format: { type: "string", default: "plain" },
    "timeout-ms": { type: "string", default: "15000" },
    agents: { type: "string", multiple: true },
    strict: { type: "boolean", default: false },
  },
  strict: true,
  allowPositionals: false,
});

const timeoutMs = Number.parseInt(values["timeout-ms"], 10);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  console.error("--timeout-ms must be a positive integer");
  process.exit(2);
}

const knownAgents: AgentDoctorName[] = ["claude", "codex", "gemini", "cursor-agent", "gh-copilot"];
const parsedAgents = values.agents?.flatMap((entry) => entry.split(",").map((value) => value.trim()).filter(Boolean)) ?? [];
const invalidAgents = parsedAgents.filter((agent) => !knownAgents.includes(agent as AgentDoctorName));
if (invalidAgents.length > 0) {
  console.error(`Unknown agent(s): ${invalidAgents.join(", ")}`);
  process.exit(2);
}

const report = await runAgentDoctor({
  timeoutMs,
  agents: parsedAgents.length > 0 ? parsedAgents as AgentDoctorName[] : undefined,
});

if (values.format === "json") {
  console.log(JSON.stringify(report, null, 2));
} else if (values.format === "plain") {
  console.log(renderAgentDoctorPlain(report));
} else {
  console.error("--format must be plain or json");
  process.exit(2);
}

if (values.strict && report.results.some((result) => result.required && !result.healthy)) {
  process.exit(1);
}
