import { describe, expect, test } from "bun:test";

import type { CommandRunner } from "../../src/pr-state/github.ts";
import {
  NOTION_MCP_ADD_COMMAND,
  formatNotionMcpPreflight,
  runNotionMcpPreflight,
  type NotionProbeRunner,
  type NotionProbeRunResult,
} from "../../src/tools/preflight_notion_mcp.ts";

type Reply = { stdout: string; stderr?: string; status?: number };

function makeRunner(
  handlers: Array<(cmd: string[]) => Reply>,
): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  let index = 0;
  const runner: CommandRunner = (cmd) => {
    calls.push(cmd);
    const handler = handlers[index++];
    if (!handler) {
      throw new Error(`unexpected runner call: ${cmd.join(" ")}`);
    }
    const r = handler(cmd);
    return { stdout: r.stdout, stderr: r.stderr ?? "", status: r.status ?? 0 };
  };
  return { runner, calls };
}

// GH-1828: probe replies now come back via the typed `NotionProbeRunner`
// seam (SDK-backed in production). The fake here mirrors the SDK collapse
// shape (`{exitCode, stdout, stderr}`).
function makeProbe(
  reply: NotionProbeRunResult,
): { probe: NotionProbeRunner; calls: Array<{ model: string; prompt: string }> } {
  const calls: Array<{ model: string; prompt: string }> = [];
  const probe: NotionProbeRunner = async ({ model, prompt }) => {
    calls.push({ model, prompt });
    return reply;
  };
  return { probe, calls };
}

function probeOk(): NotionProbeRunResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: '{"ok": true}',
    }),
    stderr: "",
  };
}

const OAUTH_PROBE_OUTPUT =
  "Please open this URL in your browser to authorize Notion access:\n" +
  "https://mcp.notion.com/authorize?response_type=code&client_id=foo";

describe("runNotionMcpPreflight", () => {
  test("ok when claude mcp list contains notion AND --print probe succeeds", async () => {
    const { runner, calls } = makeRunner([
      () => ({
        stdout: "beads: connected\nnotion: connected (https://mcp.notion.com/mcp)\n",
      }),
    ]);
    const { probe, calls: probeCalls } = makeProbe(probeOk());
    const result = await runNotionMcpPreflight(runner, process.env, probe);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("ok");
    expect(calls.length).toBe(1);
    expect(calls[0]!.slice(0, 3)).toEqual(["claude", "mcp", "list"]);
    expect(probeCalls.length).toBe(1);
  });

  test("headless-oauth-required when --print probe emits Notion authorize URL", async () => {
    const { runner, calls } = makeRunner([
      () => ({
        stdout: "notion: connected (https://mcp.notion.com/mcp)\n",
      }),
    ]);
    const { probe } = makeProbe({ exitCode: 0, stdout: OAUTH_PROBE_OUTPUT, stderr: "" });
    const result = await runNotionMcpPreflight(runner, process.env, probe);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("headless-oauth-required");
    // The OAuth authorize URL must NOT be embedded in the (logged) detail —
    // it is OAuth-sourced data (CodeQL js/clear-text-logging). We surface that
    // a URL was emitted, not the URL itself.
    expect(result.detail).toContain("OAuth URL");
    expect(result.detail).not.toContain("https://mcp.notion.com/authorize");
    expect(result.remediation).toContain("GH-847");
    expect(calls.length).toBe(1);
  });

  test("headless-oauth-required also detected on probe stderr", async () => {
    const { runner } = makeRunner([
      () => ({ stdout: "notion: connected\n" }),
    ]);
    const { probe } = makeProbe({ exitCode: 1, stdout: "", stderr: OAUTH_PROBE_OUTPUT });
    const result = await runNotionMcpPreflight(runner, process.env, probe);
    expect(result.status).toBe("headless-oauth-required");
  });

  test("fails with notion-mcp-missing when no notion entry; probe is not run", async () => {
    const { runner, calls } = makeRunner([
      () => ({ stdout: "beads: connected\n" }),
    ]);
    const { probe, calls: probeCalls } = makeProbe(probeOk());
    const result = await runNotionMcpPreflight(runner, process.env, probe);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("notion-mcp-missing");
    expect(result.remediation).toContain("claude mcp add");
    expect(result.remediation).toContain("--scope project");
    expect(calls.length).toBe(1);
    expect(probeCalls.length).toBe(0);
  });

  test("fails with claude-missing when claude binary not on PATH; probe is not run", async () => {
    const { runner, calls } = makeRunner([
      () => {
        const err = new Error("spawn claude ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      },
    ]);
    const { probe, calls: probeCalls } = makeProbe(probeOk());
    const result = await runNotionMcpPreflight(runner, process.env, probe);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("claude-missing");
    expect(result.remediation).toContain("preflight claude");
    expect(calls.length).toBe(1);
    expect(probeCalls.length).toBe(0);
  });

  test("fails with claude-list-failed on non-zero exit; probe is not run", async () => {
    const { runner, calls } = makeRunner([
      () => ({ stdout: "", stderr: "mcp list failed", status: 1 }),
    ]);
    const { probe, calls: probeCalls } = makeProbe(probeOk());
    const result = await runNotionMcpPreflight(runner, process.env, probe);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("claude-list-failed");
    expect(calls.length).toBe(1);
    expect(probeCalls.length).toBe(0);
  });

  test("probe non-zero exit without OAuth signature → claude-print-failed", async () => {
    const { runner } = makeRunner([
      () => ({ stdout: "notion: connected\n" }),
    ]);
    const { probe } = makeProbe({ exitCode: 139, stdout: "", stderr: "segfault" });
    const result = await runNotionMcpPreflight(runner, process.env, probe);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("claude-print-failed");
    expect(result.detail).toContain("--print");
  });

  test("probe exits 0 but stdout is not a JSON envelope → claude-print-failed", async () => {
    const { runner } = makeRunner([
      () => ({ stdout: "notion: connected\n" }),
    ]);
    const { probe } = makeProbe({ exitCode: 0, stdout: "not json at all", stderr: "" });
    const result = await runNotionMcpPreflight(runner, process.env, probe);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("claude-print-failed");
    expect(result.detail).toContain("not the expected JSON envelope");
  });

  test("probe respects PRX_NOTION_MCP_MODEL env override", async () => {
    const { runner } = makeRunner([
      () => ({ stdout: "notion: connected\n" }),
    ]);
    const { probe, calls: probeCalls } = makeProbe(probeOk());
    await runNotionMcpPreflight(
      runner,
      { PRX_NOTION_MCP_MODEL: "claude-haiku-4-5" },
      probe,
    );
    expect(probeCalls.length).toBe(1);
    expect(probeCalls[0]!.model).toBe("claude-haiku-4-5");
  });
});

describe("formatNotionMcpPreflight", () => {
  test("plain format reports OK", () => {
    const out = formatNotionMcpPreflight(
      { ok: true, status: "ok", detail: null, remediation: null },
      "plain",
    );
    expect(out).toContain("OK");
  });

  test("plain format includes remediation on failure", () => {
    const out = formatNotionMcpPreflight(
      {
        ok: false,
        status: "notion-mcp-missing",
        detail: "no notion entry",
        remediation: NOTION_MCP_ADD_COMMAND,
      },
      "plain",
    );
    expect(out).toContain("FAILED");
    expect(out).toContain("notion-mcp-missing");
    expect(out).toContain("claude mcp add");
  });

  test("plain format names the headless-oauth-required status", () => {
    const out = formatNotionMcpPreflight(
      {
        ok: false,
        status: "headless-oauth-required",
        detail: "claude --print emitted Notion OAuth URL",
        remediation: "switch overlay to rest. Tracking: GH-847.",
      },
      "plain",
    );
    expect(out).toContain("headless-oauth-required");
    expect(out).toContain("GH-847");
  });

  test("json format round-trips the result", () => {
    const result = {
      ok: false,
      status: "claude-missing" as const,
      detail: "d",
      remediation: "r",
    };
    const out = formatNotionMcpPreflight(result, "json");
    expect(JSON.parse(out)).toEqual(result);
  });
});
