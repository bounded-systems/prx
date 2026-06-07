// pr-state/work-agent — the io-format guard, agent-string parser, and the
// per-agent automation-profile builder (all pure).

import { describe, expect, test } from "bun:test";

import {
  buildWorkAutomationProfile,
  parseWorkAgentImplementation,
  validateWorkIoFormat,
} from "../../src/pr-state/work-agent.ts";

describe("validateWorkIoFormat", () => {
  test("rejects stream-json with copilot", () => {
    expect(() => validateWorkIoFormat("copilot", "stream-json")).toThrow(/stream-json.*copilot/);
  });
  test("passes other agent/format combinations through", () => {
    expect(validateWorkIoFormat("codex", "stream-json")).toBe("stream-json");
    expect(validateWorkIoFormat("copilot", "json")).toBe("json");
  });
});

describe("parseWorkAgentImplementation", () => {
  test("accepts a canonical agent", () => {
    expect(parseWorkAgentImplementation("codex", "--agent")).toBe("codex");
  });
  test("throws on an unknown agent with the valid list", () => {
    expect(() => parseWorkAgentImplementation("bogus", "--agent")).toThrow(/Invalid value for --agent/);
  });
});

describe("buildWorkAutomationProfile", () => {
  for (const agent of ["claude", "codex", "copilot", "gemini", "cursor"] as const) {
    test(`builds a runtime profile for ${agent}`, () => {
      const profile = buildWorkAutomationProfile(agent, "GH-1", "json", "full");
      expect(profile).toBeDefined();
      expect(typeof profile.command).toBe("string");
    });
  }
});
