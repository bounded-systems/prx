// tools/preflight_notion_mcp — the failure arms reached through the injected
// runner + probe seams: a missing `claude` binary (ENOENT) and a probe that
// throws. The happy/list arms live in preflight_notion_mcp.test.ts.

import { describe, expect, test } from "bun:test";

import type { CommandRunner } from "../../src/pr-state/github.ts";
import { runNotionMcpPreflight, type NotionProbeRunner } from "../../src/tools/preflight_notion_mcp.ts";

describe("runNotionMcpPreflight — failure arms", () => {
  test("a missing claude binary (ENOENT) → claude-missing", async () => {
    const runner = (() => {
      throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    }) as CommandRunner;
    const probe: NotionProbeRunner = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const result = await runNotionMcpPreflight(runner, {}, probe);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("claude-missing");
  });

  test("a non-ENOENT spawn failure → claude-list-failed", async () => {
    const runner = (() => {
      throw new Error("permission denied");
    }) as CommandRunner;
    const probe: NotionProbeRunner = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const result = await runNotionMcpPreflight(runner, {}, probe);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("claude-list-failed");
  });

  test("a probe that throws (after a healthy mcp list) → claude-print-failed", async () => {
    const runner = (() => ({ status: 0, stdout: "notion: https://mcp.notion.com/mcp", stderr: "" })) as CommandRunner;
    const probe: NotionProbeRunner = async () => {
      throw new Error("probe blew up");
    };
    const result = await runNotionMcpPreflight(runner, {}, probe);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("claude-print-failed");
  });
});
