import { describe, expect, test } from "bun:test";

import {
  IsolatedBeadsClient,
  BeadsProtocolError,
  type BeadsTransport,
} from "../../src/beadsd/client.ts";
import type { BeadsRequest } from "../../src/beadsd/contract.ts";

const READY: BeadsRequest = { kind: "ready" };

describe("IsolatedBeadsClient (host-side seam)", () => {
  test("sends a contract-valid request and returns the parsed ok result", async () => {
    let seen: BeadsRequest | undefined;
    const transport: BeadsTransport = async (req) => {
      seen = req;
      return { status: "ok", result: [{ id: "GH-228", status: "ready" }] };
    };
    const res = await new IsolatedBeadsClient(transport).query({ kind: "list", status: "open" });
    expect(seen).toEqual({ kind: "list", status: "open" });
    expect(res.status).toBe("ok");
    if (res.status === "ok") expect(res.result).toEqual([{ id: "GH-228", status: "ready" }]);
  });

  test("returns a daemon error verdict as DATA, not an exception", async () => {
    const transport: BeadsTransport = async () => ({
      status: "error",
      code: "not-found",
      message: "no such id",
    });
    const res = await new IsolatedBeadsClient(transport).query({ kind: "show", id: "GH-x" });
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.code).toBe("not-found");
  });

  test("rejects a malformed request BEFORE hitting the transport", async () => {
    let called = false;
    const transport: BeadsTransport = async () => {
      called = true;
      return { status: "ok", result: null };
    };
    const bad = { kind: "show" } as unknown as BeadsRequest; // missing id
    await expect(new IsolatedBeadsClient(transport).query(bad)).rejects.toBeInstanceOf(
      BeadsProtocolError,
    );
    expect(called).toBe(false);
  });

  test("rejects a reply that violates the wire contract", async () => {
    const transport: BeadsTransport = async () => ({ status: "error", message: "no code" });
    await expect(new IsolatedBeadsClient(transport).query(READY)).rejects.toBeInstanceOf(
      BeadsProtocolError,
    );
  });
});
