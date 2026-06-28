import { describe, expect, test } from "bun:test";

import { applyBrokeredGhToken } from "../apply.ts";
import type { BrokerConfig } from "../broker-config.ts";
import type { Broker } from "../broker.ts";

const envFrom =
  (rec: Record<string, string>) =>
  (key: string): string | undefined =>
    rec[key];

const CONFIG: BrokerConfig = {
  issuer: "Iv1",
  privateKeyPem: "SECRET-PEM",
  installationId: "1",
  source: "inline",
};

const okBroker = (token: string): Broker => ({
  ensure: async () => ({ token, expiresAt: 999, permissions: { contents: "read" } }),
  peek: () => null,
  reset: () => {},
});

describe("applyBrokeredGhToken", () => {
  test("env-token-present: no-op when GH_TOKEN is already set (CI precedence)", async () => {
    const sets: Array<[string, string]> = [];
    const r = await applyBrokeredGhToken({
      getEnv: envFrom({ GH_TOKEN: "ghs_existing" }),
      setEnv: (k, v) => sets.push([k, v]),
      resolveConfig: () => {
        throw new Error("must not resolve when a token is present");
      },
    });
    expect(r).toEqual({ applied: false, reason: "env-token-present" });
    expect(sets).toHaveLength(0);
  });

  test("not-configured: fail-open no-op, no throw", async () => {
    const sets: Array<[string, string]> = [];
    const r = await applyBrokeredGhToken({
      getEnv: envFrom({}),
      setEnv: (k, v) => sets.push([k, v]),
      resolveConfig: () => null,
    });
    expect(r).toEqual({ applied: false, reason: "not-configured" });
    expect(sets).toHaveLength(0);
  });

  test("configured: mints, sets GH_TOKEN once, returns a non-secret summary", async () => {
    const sets: Array<[string, string]> = [];
    const r = await applyBrokeredGhToken({
      getEnv: envFrom({}),
      setEnv: (k, v) => sets.push([k, v]),
      resolveConfig: () => CONFIG,
      createBroker: () => okBroker("ghs_minted"),
    });
    expect(sets).toEqual([["GH_TOKEN", "ghs_minted"]]);
    expect(r.applied).toBe(true);
    if (r.applied) {
      expect(r.source).toBe("inline");
      expect(r.permissions.contents).toBe("read");
    }
    // The summary must not leak the token or the PEM.
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain("ghs_minted");
    expect(serialized).not.toContain("SECRET-PEM");
  });

  test("configured-but-mint-fails: throws (fail-closed)", async () => {
    await expect(
      applyBrokeredGhToken({
        getEnv: envFrom({}),
        setEnv: () => {},
        resolveConfig: () => CONFIG,
        createBroker: () => ({
          ensure: async () => {
            throw new Error("mint boom");
          },
          peek: () => null,
          reset: () => {},
        }),
      }),
    ).rejects.toThrow("mint boom");
  });
});
