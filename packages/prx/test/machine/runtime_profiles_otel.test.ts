// GH-188: `agentOtelEnv` turns on Claude Code OTel for a headless agent leg only
// when an OTLP collector is configured — OTLP only (never `console`, which would
// corrupt the Agent SDK stdout pipe), and a no-op otherwise (safe to ship dark).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { agentOtelEnv } from "../../src/machine/runtime_profiles.ts";

const KEYS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_SERVICE_NAME",
  "PRX_OTEL_DISABLE",
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("agentOtelEnv (GH-188)", () => {
  test("no endpoint configured → empty (telemetry stays off)", () => {
    expect(agentOtelEnv("executor")).toEqual({});
  });

  test("with an OTLP endpoint → enables Claude Code OTel, OTLP exporters, actor-tagged", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    const env = agentOtelEnv("planner");
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
    expect(env.OTEL_METRICS_EXPORTER).toBe("otlp");
    expect(env.OTEL_LOGS_EXPORTER).toBe("otlp");
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toContain("prx.actor=planner");
    expect(env.OTEL_SERVICE_NAME).toBe("prx");
  });

  test("never selects the console exporter (it corrupts the Agent SDK stdout pipe)", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    const env = agentOtelEnv("executor");
    expect(Object.values(env)).not.toContain("console");
  });

  test("PRX_OTEL_DISABLE=1 forces off even with an endpoint", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    process.env.PRX_OTEL_DISABLE = "1";
    expect(agentOtelEnv("executor")).toEqual({});
  });

  test("honors a host-provided protocol", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4317";
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc";
    expect(agentOtelEnv("tester").OTEL_EXPORTER_OTLP_PROTOCOL).toBe("grpc");
  });
});
