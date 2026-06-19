import { describe, expect, test } from "bun:test";

import { handleMcpRequest, MCP_PROTOCOL_VERSION, type JsonRpcRequest } from "./mcp-server.ts";
import { orchestratorRegistry } from "./pilot-verbs.ts";

const call = (
  method: string,
  params?: Record<string, unknown>,
  id: number | null = 1,
): JsonRpcRequest => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params ? { params } : {}),
});

describe("prx mcp serve (registry mounted as an MCP server)", () => {
  test("initialize advertises the tools capability + serverInfo", async () => {
    const res = await handleMcpRequest(orchestratorRegistry, call("initialize"));
    const result = res!.result as {
      protocolVersion: string;
      capabilities: object;
      serverInfo: { name: string };
    };
    expect(result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(result.serverInfo.name).toBe("prx");
    expect(result.capabilities).toHaveProperty("tools");
  });

  test("tools/list returns the projected toolset", async () => {
    const res = await handleMcpRequest(orchestratorRegistry, call("tools/list"));
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(["fleet", "observe", "pilot"]);
  });

  test("tools/call drives the pilot machine and returns its rendered output", async () => {
    const res = await handleMcpRequest(
      orchestratorRegistry,
      call("tools/call", { name: "pilot", arguments: { workUnitId: "GH-7" } }),
    );
    const result = res!.result as { content: { text: string }[]; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain('"finalState": "merged"');
  });

  test("tools/call passes structured args straight to the schema (arrays as arrays)", async () => {
    const res = await handleMcpRequest(
      orchestratorRegistry,
      call("tools/call", { name: "fleet", arguments: { units: ["a", "b"], wip: 2 } }),
    );
    const result = res!.result as { content: { text: string }[] };
    expect(result.content[0]!.text).toContain('"unitCount": 2');
    expect(result.content[0]!.text).toContain('"merged": 2');
  });

  test("an unknown tool and invalid args are isError tool results, not RPC errors", async () => {
    const unknown = await handleMcpRequest(
      orchestratorRegistry,
      call("tools/call", { name: "nope", arguments: {} }),
    );
    expect((unknown!.result as { isError: boolean }).isError).toBe(true);

    const invalid = await handleMcpRequest(
      orchestratorRegistry,
      call("tools/call", { name: "pilot", arguments: {} }), // missing workUnitId
    );
    const r = invalid!.result as { isError: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("error:");
  });

  test("notifications get no reply; unknown methods are JSON-RPC errors", async () => {
    expect(
      await handleMcpRequest(
        orchestratorRegistry,
        call("notifications/initialized", undefined, null),
      ),
    ).toBeNull();

    const bad = await handleMcpRequest(orchestratorRegistry, call("does/not/exist"));
    expect(bad!.error!.code).toBe(-32601);
  });
});
