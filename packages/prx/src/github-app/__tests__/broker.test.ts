import { describe, expect, test } from "bun:test";

import type { BrokerConfig } from "../broker-config.ts";
import { createBroker } from "../broker.ts";
import type { mintInstallationToken } from "../installation-token.ts";

const CONFIG: BrokerConfig = {
  issuer: "Iv1",
  privateKeyPem: "PEM",
  installationId: "1",
  source: "inline",
};

const EXPIRES = "2026-01-01T01:00:00Z";
const T0 = Date.parse("2026-01-01T00:00:00Z"); // 1h before expiry → fresh (5m margin)

/** Build a typed mint fake from a thunk. */
function mintReturning(
  impl: () => Promise<{ token: string; expiresAt: string; permissions: Record<string, string> }>,
): typeof mintInstallationToken {
  return ((_input, _deps) => impl()) as typeof mintInstallationToken;
}

describe("createBroker", () => {
  test("caches: a second ensure() within margin does not re-mint", async () => {
    let mints = 0;
    const broker = createBroker(CONFIG, {
      mint: mintReturning(async () => ({ token: `t${++mints}`, expiresAt: EXPIRES, permissions: {} })),
      now: () => T0,
    });
    const a = await broker.ensure();
    const b = await broker.ensure();
    expect(mints).toBe(1);
    expect(b.token).toBe(a.token);
    expect(b.expiresAt).toBe(Date.parse(EXPIRES));
  });

  test("re-mints when within the refresh margin of expiry", async () => {
    let mints = 0;
    let now = T0;
    const broker = createBroker(CONFIG, {
      mint: mintReturning(async () => ({ token: `t${++mints}`, expiresAt: EXPIRES, permissions: {} })),
      now: () => now,
    });
    await broker.ensure();
    now = Date.parse("2026-01-01T00:56:00Z"); // within 5m of 01:00 expiry
    await broker.ensure();
    expect(mints).toBe(2);
  });

  test("concurrent ensure() calls dedupe to a single mint", async () => {
    let mints = 0;
    const broker = createBroker(CONFIG, {
      mint: mintReturning(async () => {
        mints++;
        await Promise.resolve();
        return { token: "t", expiresAt: EXPIRES, permissions: {} };
      }),
      now: () => T0,
    });
    await Promise.all([broker.ensure(), broker.ensure(), broker.ensure()]);
    expect(mints).toBe(1);
  });

  test("reset() drops the cache and forces a re-mint", async () => {
    let mints = 0;
    const broker = createBroker(CONFIG, {
      mint: mintReturning(async () => ({ token: `t${++mints}`, expiresAt: EXPIRES, permissions: {} })),
      now: () => T0,
    });
    await broker.ensure();
    broker.reset();
    expect(broker.peek()).toBeNull();
    await broker.ensure();
    expect(mints).toBe(2);
  });

  test("a mint rejection is not cached; the next ensure() retries", async () => {
    let mints = 0;
    const broker = createBroker(CONFIG, {
      mint: mintReturning(async () => {
        mints++;
        if (mints === 1) throw new Error("boom");
        return { token: "ok", expiresAt: EXPIRES, permissions: {} };
      }),
      now: () => T0,
    });
    await expect(broker.ensure()).rejects.toThrow("boom");
    expect(broker.peek()).toBeNull();
    const t = await broker.ensure();
    expect(t.token).toBe("ok");
    expect(mints).toBe(2);
  });
});
