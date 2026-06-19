import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  defineVerb,
  dispatchNdjson,
  handleJsonRpc,
  toOpenRpcDocument,
  toOpenRpcMethod,
  type JsonRpcResponse,
  type Registry,
} from "./index.ts";

// A tiny registry standing in for a daemon's verbs (cf. keeperd's
// sign/verify/status): one spaced id to exercise token resolution, and a verb
// that throws to exercise the internal-error mapping.
const sign = defineVerb({
  id: "sign",
  summary: "sign a payload",
  actor: "keeper",
  input: z.object({ payload: z.string() }),
  output: z.object({ signature: z.string() }),
  run: ({ payload }) => ({ signature: `sig:${payload}` }),
});

const planSession = defineVerb({
  id: "plan session",
  summary: "open a plan session",
  actor: "planner",
  input: z.object({ unit: z.string() }),
  output: z.object({ ok: z.boolean() }),
  run: () => ({ ok: true }),
});

const boom = defineVerb({
  id: "boom",
  summary: "always throws",
  actor: "keeper",
  input: z.object({}),
  output: z.object({}),
  run: () => {
    throw new Error("kaboom");
  },
});

const reg: Registry = { sign, "plan session": planSession, boom };

describe("OpenRPC projection", () => {
  test("a verb projects to an OpenRPC Method Object with by-name params + result", () => {
    const m = toOpenRpcMethod(sign) as Record<string, unknown>;
    expect(m.name).toBe("sign");
    expect(m.summary).toBe("sign a payload");
    expect(m["x-prx-actor"]).toBe("keeper");
    expect(m.params).toEqual([
      { name: "payload", required: true, schema: expect.objectContaining({ type: "string" }) },
    ]);
    expect(m.result).toMatchObject({ name: "sign_result" });
  });

  test("a spaced id is tokenized in the method name", () => {
    expect((toOpenRpcMethod(planSession) as { name: string }).name).toBe("plan_session");
  });

  test("the registry projects to an OpenRPC document", () => {
    const doc = toOpenRpcDocument(reg, { title: "keeperd", version: "1.2.3" }) as Record<
      string,
      unknown
    >;
    expect(doc.openrpc).toBe("1.3.2");
    expect(doc.info).toEqual({ title: "keeperd", version: "1.2.3" });
    expect((doc.methods as { name: string }[]).map((m) => m.name)).toEqual([
      "sign",
      "plan_session",
      "boom",
    ]);
  });
});

describe("JSON-RPC / NDJSON projection", () => {
  const ok = (r: JsonRpcResponse) => (r as { result: unknown }).result;
  const error = (r: JsonRpcResponse) => (r as { error: { code: number; message: string } }).error;

  test("a valid request runs the verb and returns a result", async () => {
    const r = await handleJsonRpc(reg, {
      jsonrpc: "2.0",
      id: 1,
      method: "sign",
      params: { payload: "abc" },
    });
    expect(ok(r)).toEqual({ signature: "sig:abc" });
    expect((r as { id: unknown }).id).toBe(1);
  });

  test("a spaced verb id resolves by its token", async () => {
    const r = await handleJsonRpc(reg, { id: 2, method: "plan_session", params: { unit: "u1" } });
    expect(ok(r)).toEqual({ ok: true });
  });

  test("an unknown method is a -32601", async () => {
    const r = await handleJsonRpc(reg, { id: 3, method: "nope", params: {} });
    expect(error(r).code).toBe(-32601);
  });

  test("bad params surface as -32602 with the Zod issues as data", async () => {
    const r = await handleJsonRpc(reg, { id: 4, method: "sign", params: { payload: 123 } });
    expect(error(r).code).toBe(-32602);
    expect((r as { error: { data: unknown[] } }).error.data).toBeArray();
  });

  test("a throwing verb maps to a -32603 internal error", async () => {
    const r = await handleJsonRpc(reg, { id: 5, method: "boom", params: {} });
    expect(error(r)).toMatchObject({ code: -32603, message: "kaboom" });
  });

  test("dispatchNdjson round-trips a line and emits a single response line", async () => {
    const line = await dispatchNdjson(
      reg,
      JSON.stringify({ id: 6, method: "sign", params: { payload: "z" } }),
    );
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toMatchObject({
      jsonrpc: "2.0",
      id: 6,
      result: { signature: "sig:z" },
    });
  });

  test("a malformed line is a -32700 parse error with a null id", async () => {
    const r = JSON.parse(await dispatchNdjson(reg, "{not json")) as JsonRpcResponse;
    expect(r.id).toBeNull();
    expect(error(r).code).toBe(-32700);
  });
});
