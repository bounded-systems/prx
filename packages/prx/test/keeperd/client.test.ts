import { describe, expect, test } from "bun:test";

import {
  IsolatedKeeperClient,
  KeeperProtocolError,
  type KeeperTransport,
} from "../../src/keeperd/client.ts";
import type { KeeperRemoteRequest } from "../../src/keeperd/contract.ts";

const REQUEST: KeeperRemoteRequest = {
  kind: "commit-and-push",
  bundleBase64: "ZGVhZGJlZWY=",
  treeSha: "a".repeat(40),
  parentSha: "b".repeat(40),
  message: "GH-456: materialize submit artifact",
  date: "2026-06-05T00:00:00Z",
  branch: "GH-456",
  remote: "origin",
};

describe("IsolatedKeeperClient (host-side seam)", () => {
  test("sends a contract-valid request and returns the parsed ok verdict", async () => {
    let seen: KeeperRemoteRequest | undefined;
    const transport: KeeperTransport = async (req) => {
      seen = req;
      return { status: "ok", commitSha: "c".repeat(40), pushedRef: "refs/heads/GH-456" };
    };
    const result = await new IsolatedKeeperClient(transport).commitAndPush(REQUEST);

    expect(seen).toEqual(REQUEST);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.commitSha).toBe("c".repeat(40));
  });

  test("returns a daemon error verdict as DATA, not an exception", async () => {
    const transport: KeeperTransport = async () => ({
      status: "error",
      code: "policy-denied",
      message: "role=keeper denied git push",
    });
    const result = await new IsolatedKeeperClient(transport).commitAndPush(REQUEST);
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.code).toBe("policy-denied");
  });

  test("rejects a malformed request BEFORE hitting the transport", async () => {
    let called = false;
    const transport: KeeperTransport = async () => {
      called = true;
      return { status: "ok", commitSha: "c".repeat(40), pushedRef: "x" };
    };
    const bad = { ...REQUEST, treeSha: "not-a-sha" } as unknown as KeeperRemoteRequest;
    await expect(new IsolatedKeeperClient(transport).commitAndPush(bad)).rejects.toBeInstanceOf(
      KeeperProtocolError,
    );
    // The capability boundary held: an invalid git-write request never reached
    // the channel to the in-VM keeper.
    expect(called).toBe(false);
  });

  test("rejects a reply that violates the wire contract", async () => {
    const transport: KeeperTransport = async () => ({ status: "ok" /* missing commitSha/pushedRef */ });
    await expect(new IsolatedKeeperClient(transport).commitAndPush(REQUEST)).rejects.toBeInstanceOf(
      KeeperProtocolError,
    );
  });

  test("surfaces the offending field in the protocol error message", async () => {
    const transport: KeeperTransport = async () => ({ status: "ok", commitSha: "nope", pushedRef: "r" });
    await expect(
      new IsolatedKeeperClient(transport).commitAndPush(REQUEST),
    ).rejects.toThrow(/commitSha/);
  });
});
