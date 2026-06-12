/**
 * SPIKE — `prx mcp serve`: the runtime side of the Claude plugin.
 *
 * Mounts the canonical verb registry as an MCP server. Tools = `toMcpToolset`;
 * a `tools/call` resolves the verb (by `verbToken`), validates the arguments
 * against the verb's Zod input, runs it, and returns the rendered output. The
 * plugin's `.mcp.json` points Claude here, so the plugin's slash commands and
 * this server's tools are the same registry — they can't drift.
 *
 * `handleMcpRequest` is transport-agnostic (pure JSON-RPC in/out) and is the
 * unit under test. `serveStdio` is the thin newline-delimited-JSON shell; a
 * production server would swap in `@modelcontextprotocol/sdk` without changing
 * the handler. The MCP path takes structured JSON args (arrays arrive as real
 * arrays) — no CLI-isms; the Zod schema is the only validation.
 */

import { render, toMcpToolset, verbToken, type Registry } from "@bounded-systems/verbspec";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export type JsonRpcId = number | string | null;
export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};
export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export type McpServerInfo = { name: string; version: string };
const DEFAULT_INFO: McpServerInfo = { name: "prx", version: "0.0.0-spike" };

const ok = (id: JsonRpcId, result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });

/**
 * Handle one JSON-RPC request. Returns `null` for notifications (no response).
 * Tool errors are returned as `isError` tool results, not JSON-RPC errors, per
 * MCP — the model sees the failure and can react.
 */
export async function handleMcpRequest(
  reg: Registry,
  req: JsonRpcRequest,
  info: McpServerInfo = DEFAULT_INFO,
): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;
  switch (req.method) {
    case "initialize":
      return ok(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: info,
      });
    case "notifications/initialized":
      return null; // notification — no reply
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: toMcpToolset(reg) });
    case "tools/call": {
      const name = req.params?.name as string | undefined;
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
      const verb = Object.values(reg).find((v) => verbToken(v.id) === name);
      if (!verb) {
        return ok(id, { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true });
      }
      try {
        const input = verb.input.parse(args); // structured JSON → Zod validates
        const output = await verb.run(input);
        return ok(id, { content: [{ type: "text", text: render(output) }] });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return ok(id, { content: [{ type: "text", text: `error: ${msg}` }], isError: true });
      }
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${req.method}` } };
  }
}

/**
 * Thin stdio shell: newline-delimited JSON-RPC over stdin/stdout. Untested glue
 * around `handleMcpRequest`; prod swaps in the official MCP stdio transport.
 */
export async function serveStdio(reg: Registry, info: McpServerInfo = DEFAULT_INFO): Promise<void> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      continue; // skip malformed frames
    }
    const res = await handleMcpRequest(reg, req, info);
    if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
  }
}
