// The keeperd client endpoint resolver — the keeper analog of resolveBeadsEndpoint.
// Reads PRX_KEEPER_* the per-repo pod projects into a consumer room (prx-asr).

import { describe, expect, test } from "bun:test";

import {
  resolveKeeperEndpoint,
  DEFAULT_LOCAL_KEEPER_SOCKET,
  DEFAULT_VM_KEEPER_SOCKET,
} from "../../src/keeperd/endpoint.ts";

/** A fake env lookup over a fixed map. */
const fakeEnv = (vars: Record<string, string | undefined>) => (k: string) => vars[k];

describe("resolveKeeperEndpoint", () => {
  test("defaults to a local socket", () => {
    expect(resolveKeeperEndpoint(fakeEnv({}))).toEqual({
      kind: "local",
      socket: DEFAULT_LOCAL_KEEPER_SOCKET,
    });
  });

  test("PRX_KEEPER_SOCKET overrides the local socket (the pod door case)", () => {
    expect(resolveKeeperEndpoint(fakeEnv({ PRX_KEEPER_SOCKET: "/run/prx/doors/keeperd.sock" }))).toEqual({
      kind: "local",
      socket: "/run/prx/doors/keeperd.sock",
    });
  });

  test("PRX_KEEPER_VM selects the Lima VM daemon (+ default vm socket)", () => {
    expect(resolveKeeperEndpoint(fakeEnv({ PRX_KEEPER_VM: "myvm" }))).toEqual({
      kind: "lima",
      vm: "myvm",
      vmSocket: DEFAULT_VM_KEEPER_SOCKET,
    });
  });

  test("PRX_KEEPER_VM_SOCKET overrides the in-VM socket", () => {
    expect(resolveKeeperEndpoint(fakeEnv({ PRX_KEEPER_VM: "myvm", PRX_KEEPER_VM_SOCKET: "/v/k.sock" }))).toEqual({
      kind: "lima",
      vm: "myvm",
      vmSocket: "/v/k.sock",
    });
  });
});
