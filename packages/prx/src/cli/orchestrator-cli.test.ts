import { describe, expect, test } from "bun:test";

import { runOrchestratorVerb } from "./orchestrator-cli.ts";

const sink = () => {
  const lines: string[] = [];
  return { out: { log: (s: string) => lines.push(s), error: (s: string) => lines.push(`ERR:${s}`) }, lines };
};

describe("runOrchestratorVerb — the `prx pilot`/`prx fleet` bridge", () => {
  test("pilot drives the (stub) pipeline to merged and exits 0", async () => {
    const { out, lines } = sink();
    const code = await runOrchestratorVerb("pilot", ["GH-9"], out);
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain('"finalState": "merged"');
  });

  test("fleet runs over comma-split units and exits 0", async () => {
    const { out, lines } = sink();
    const code = await runOrchestratorVerb("fleet", ["a,b,c"], out);
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain('"unitCount": 3');
  });

  test("a missing required arg surfaces an error and exits 1", async () => {
    const { out, lines } = sink();
    const code = await runOrchestratorVerb("pilot", [], out);
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("ERR:");
  });
});
