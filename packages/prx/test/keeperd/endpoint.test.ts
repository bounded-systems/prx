import { describe, expect, test } from "bun:test";

import {
  DEFAULT_LOCAL_KEEPER_SOCKET,
  isKeeperDoorMode,
  resolveKeeperEndpoint,
} from "../../src/keeperd/endpoint.ts";

/** A fake env over a fixed map (mirrors the @bounded-systems/env getEnv shape). */
const fakeEnv = (vars: Record<string, string>) => (key: string) => vars[key];

describe("isKeeperDoorMode", () => {
  test("true when PRX_KEEPER_DOOR is set", () => {
    expect(isKeeperDoorMode(fakeEnv({ PRX_KEEPER_DOOR: "keeperd" }))).toBe(true);
  });

  test("false when absent", () => {
    expect(isKeeperDoorMode(fakeEnv({}))).toBe(false);
  });
});

describe("resolveKeeperEndpoint", () => {
  test("uses PRX_KEEPER_SOCKET when set (the projected door address)", () => {
    expect(
      resolveKeeperEndpoint(fakeEnv({ PRX_KEEPER_SOCKET: "/run/prx/doors/keeperd.sock" })),
    ).toEqual({
      socket: "/run/prx/doors/keeperd.sock",
    });
  });

  test("falls back to the local default", () => {
    expect(resolveKeeperEndpoint(fakeEnv({}))).toEqual({ socket: DEFAULT_LOCAL_KEEPER_SOCKET });
  });

  test("a host:port endpoint passes through (for resolveFramedTransport)", () => {
    expect(resolveKeeperEndpoint(fakeEnv({ PRX_KEEPER_SOCKET: "localhost:3002" }))).toEqual({
      socket: "localhost:3002",
    });
  });
});
