import { describe, expect, test } from "bun:test";

import { ForgeDProtocolError, IsolatedForgeDClient, type ForgeDTransport } from "../client.ts";

describe("IsolatedForgeDClient", () => {
  test("sends a validated lease request and returns the parsed ok reply", async () => {
    let sent: unknown;
    const transport: ForgeDTransport = async (req) => {
      sent = req;
      return {
        status: "ok",
        token: "ghs_x",
        expiresAt: "2026-06-27T23:59:59Z",
        permissions: { contents: "read" },
      };
    };
    const client = new IsolatedForgeDClient(transport);

    const reply = await client.lease({ kind: "lease", repositories: ["prx"] });
    expect(sent).toEqual({ kind: "lease", repositories: ["prx"] });
    expect(reply.status).toBe("ok");
    if (reply.status === "ok") expect(reply.token).toBe("ghs_x");
  });

  test("an error lease result is data, not an exception", async () => {
    const transport: ForgeDTransport = async () => ({
      status: "error",
      code: "not-configured",
      message: "forge-d holds no GitHub App key",
    });
    const reply = await new IsolatedForgeDClient(transport).lease({ kind: "lease" });
    expect(reply.status).toBe("error");
  });

  test("a reply that violates the contract throws ForgeDProtocolError", async () => {
    const transport: ForgeDTransport = async () => ({ status: "ok" }); // missing token/expiresAt
    await expect(new IsolatedForgeDClient(transport).lease({ kind: "lease" })).rejects.toBeInstanceOf(
      ForgeDProtocolError,
    );
  });
});
