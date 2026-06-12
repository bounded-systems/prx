// `prx mcp serve` (SPIKE) — the JSON-RPC handler and the stdio shell.
//
// handleMcpRequest is the transport-agnostic unit; serveStdio is the
// newline-delimited-JSON glue. Both are driven against a one-verb fake
// registry — no real verb registry, no MCP SDK.

import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { z } from "zod";

import { handleMcpRequest, serveStdio, MCP_PROTOCOL_VERSION } from "../../src/cli/mcp-server.ts";
import { verbToken, type Registry, type VerbSpec } from "@bounded-systems/verbspec";

const echo: VerbSpec = {
  id: "test.echo",
  summary: "echo back the message",
  actor: "prx",
  input: z.object({ msg: z.string() }),
  output: z.object({ echoed: z.string() }),
  run: (input) => ({ echoed: (input as { msg: string }).msg }),
};
const reg: Registry = { echo };
const ECHO_TOOL = verbToken(echo.id);

const rpc = (method: string, params?: Record<string, unknown>, id: number | string | null = 1) => ({
  jsonrpc: "2.0" as const,
  id,
  method,
  ...(params ? { params } : {}),
});

describe("handleMcpRequest", () => {
  test("initialize advertises protocol version + tools capability", async () => {
    const res = await handleMcpRequest(reg, rpc("initialize"));
    expect(res?.result).toMatchObject({
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "prx" },
    });
  });

  test("custom serverInfo is echoed through", async () => {
    const res = await handleMcpRequest(reg, rpc("initialize"), { name: "x", version: "9" });
    expect((res?.result as { serverInfo: unknown }).serverInfo).toEqual({ name: "x", version: "9" });
  });

  test("notifications/initialized is a notification (null, no reply)", async () => {
    expect(await handleMcpRequest(reg, rpc("notifications/initialized", undefined, null))).toBeNull();
  });

  test("ping returns an empty result", async () => {
    const res = await handleMcpRequest(reg, rpc("ping"));
    expect(res).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  test("tools/list projects the registry to an MCP toolset", async () => {
    const res = await handleMcpRequest(reg, rpc("tools/list"));
    const tools = (res?.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.some((t) => t.name === ECHO_TOOL)).toBe(true);
  });

  test("tools/call runs the verb and renders its output", async () => {
    const res = await handleMcpRequest(reg, rpc("tools/call", { name: ECHO_TOOL, arguments: { msg: "hi" } }));
    const content = (res?.result as { content: Array<{ text: string }> }).content;
    expect(JSON.parse(content[0]!.text)).toEqual({ echoed: "hi" });
  });

  test("tools/call defaults missing arguments to {} (and fails Zod → isError)", async () => {
    const res = await handleMcpRequest(reg, rpc("tools/call", { name: ECHO_TOOL }));
    expect((res?.result as { isError: boolean }).isError).toBe(true);
    expect((res?.result as { content: Array<{ text: string }> }).content[0]!.text).toContain("error:");
  });

  test("tools/call on an unknown tool returns an isError result", async () => {
    const res = await handleMcpRequest(reg, rpc("tools/call", { name: "nope", arguments: {} }));
    expect((res?.result as { isError: boolean }).isError).toBe(true);
    expect((res?.result as { content: Array<{ text: string }> }).content[0]!.text).toContain("unknown tool: nope");
  });

  test("tools/call surfaces a thrown run() as an isError result", async () => {
    const boomReg: Registry = {
      boom: { ...echo, id: "test.boom", run: () => { throw new Error("kaboom"); } },
    };
    const res = await handleMcpRequest(boomReg, rpc("tools/call", { name: verbToken("test.boom"), arguments: { msg: "x" } }));
    expect((res?.result as { isError: boolean }).isError).toBe(true);
    expect((res?.result as { content: Array<{ text: string }> }).content[0]!.text).toContain("kaboom");
  });

  test("an unknown method is a JSON-RPC method-not-found error", async () => {
    const res = await handleMcpRequest(reg, rpc("frobnicate"));
    expect(res?.error).toMatchObject({ code: -32601 });
    expect(res?.error?.message).toContain("frobnicate");
  });

  test("a request without an id defaults to null", async () => {
    const res = await handleMcpRequest(reg, { jsonrpc: "2.0", method: "ping" });
    expect(res?.id).toBeNull();
  });
});

describe("serveStdio", () => {
  test("replies to real frames, skips empty/malformed/notification lines", async () => {
    const frames = [
      JSON.stringify(rpc("ping", undefined, 7)), // → one response
      "", // skipped (blank)
      "{ not json", // skipped (malformed)
      JSON.stringify(rpc("notifications/initialized", undefined, null)), // null → no write
    ].join("\n") + "\n";

    const fakeStdin = Readable.from([frames]);
    const written: string[] = [];
    const origStdin = process.stdin;
    const origWrite = process.stdout.write.bind(process.stdout);
    Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });
    (process.stdout as { write: unknown }).write = (chunk: unknown) => {
      written.push(String(chunk));
      return true;
    };
    try {
      await serveStdio(reg);
    } finally {
      Object.defineProperty(process, "stdin", { value: origStdin, configurable: true });
      (process.stdout as { write: unknown }).write = origWrite;
    }

    // Only the ping produced a frame; the others wrote nothing.
    expect(written).toHaveLength(1);
    const parsed = JSON.parse(written[0]!);
    expect(parsed).toMatchObject({ id: 7, result: {} });
  });
});
