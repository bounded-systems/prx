import { describe, expect, test } from "bun:test";
import {
  webApiSlackTransport,
  SlackReadError,
  type ScopedSlackKey,
  type SlackReadOp,
} from "@bounded-systems/slack";

// A key that records its authorize() args and injects a bearer header.
function fakeKey(seen: { op?: SlackReadOp; channel?: string | undefined }): ScopedSlackKey {
  return {
    keyId: "k1",
    scope: { ops: ["channels", "history", "thread", "users"] },
    expiresAt: 9e15,
    authorize(op, channel, req) {
      seen.op = op;
      seen.channel = channel;
      return { ...req, headers: { ...(req.headers ?? {}), Authorization: "Bearer T" } };
    },
  };
}

// A fetch that records the request and returns a canned JSON Response.
function fakeFetch(
  captured: { url?: string | undefined; auth?: string | undefined },
  body: unknown,
  status = 200,
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    captured.url = String(url);
    captured.auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"];
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("webApiSlackTransport", () => {
  test("channels -> conversations.list, with bearer injected by the key", async () => {
    const cap: { url?: string; auth?: string } = {};
    const seen: { op?: SlackReadOp; channel?: string } = {};
    const t = webApiSlackTransport({
      fetch: fakeFetch(cap, {
        ok: true,
        channels: [{ id: "C1", name: "general" }],
        response_metadata: { next_cursor: "CURSOR2" },
      }),
      baseUrl: "https://x/api",
    });
    const r = await t.call("channels", { limit: 5, types: "public_channel" }, fakeKey(seen));
    expect(cap.url).toBe("https://x/api/conversations.list?limit=5&types=public_channel");
    expect(cap.auth).toBe("Bearer T");
    expect(seen.op).toBe("channels");
    expect(seen.channel).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.cursor).toBe("CURSOR2");
  });

  test("history -> conversations.history, passing the channel to authorize()", async () => {
    const cap: { url?: string } = {};
    const seen: { op?: SlackReadOp; channel?: string } = {};
    const t = webApiSlackTransport({
      fetch: fakeFetch(cap, { ok: true, messages: [] }),
      baseUrl: "https://x/api",
    });
    await t.call("history", { channel: "C1", limit: 2 }, fakeKey(seen));
    expect(cap.url).toBe("https://x/api/conversations.history?channel=C1&limit=2");
    expect(seen.channel).toBe("C1");
  });

  test("thread -> conversations.replies with channel + ts", async () => {
    const cap: { url?: string } = {};
    const t = webApiSlackTransport({
      fetch: fakeFetch(cap, { ok: true, messages: [] }),
      baseUrl: "https://x/api",
    });
    await t.call("thread", { channel: "C1", ts: "169.1" }, fakeKey({}));
    expect(cap.url).toBe("https://x/api/conversations.replies?channel=C1&ts=169.1");
  });

  test("users -> users.list; empty next_cursor becomes null", async () => {
    const cap: { url?: string } = {};
    const t = webApiSlackTransport({
      fetch: fakeFetch(cap, { ok: true, members: [], response_metadata: { next_cursor: "" } }),
      baseUrl: "https://x/api",
    });
    const r = await t.call("users", {}, fakeKey({}));
    expect(cap.url).toBe("https://x/api/users.list");
    expect(r.cursor).toBeNull();
  });

  test("an auth error maps to UNAUTHORIZED", async () => {
    const t = webApiSlackTransport({
      fetch: fakeFetch({}, { ok: false, error: "invalid_auth" }),
      baseUrl: "https://x/api",
    });
    try {
      await t.call("channels", {}, fakeKey({}));
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SlackReadError);
      expect((e as SlackReadError).code).toBe("UNAUTHORIZED");
    }
  });

  test("a non-auth slack error maps to TRANSPORT_FAILED", async () => {
    const t = webApiSlackTransport({
      fetch: fakeFetch({}, { ok: false, error: "channel_not_found" }),
      baseUrl: "https://x/api",
    });
    await expect(t.call("history", { channel: "CX" }, fakeKey({}))).rejects.toMatchObject({
      code: "TRANSPORT_FAILED",
    });
  });

  test("a non-200 HTTP status maps to TRANSPORT_FAILED", async () => {
    const t = webApiSlackTransport({
      fetch: fakeFetch({}, { ok: false }, 503),
      baseUrl: "https://x/api",
    });
    await expect(t.call("users", {}, fakeKey({}))).rejects.toMatchObject({
      code: "TRANSPORT_FAILED",
    });
  });
});
