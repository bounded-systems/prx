import { describe, expect, test } from "bun:test";

import type { SignedGrant } from "@bounded-systems/guest-room";

import { cachingGrantProvider } from "../../src/door/grant-provider.ts";

// The provider only reads `binding.exp`; a minimal fake suffices for the
// cache/refresh/dedupe logic (the real signing loop is covered elsewhere).
const grantExpiring = (exp: number, tag = "g"): SignedGrant =>
  ({ signature: tag, binding: { exp } }) as unknown as SignedGrant;

describe("cachingGrantProvider", () => {
  test("returns the acquired grant and caches it while fresh", async () => {
    let calls = 0;
    const p = cachingGrantProvider({
      acquire: () => {
        calls++;
        return grantExpiring(100_000);
      },
      now: () => 0,
      refreshMarginMs: 1_000,
    });
    expect((await p.current()).signature).toBe("g");
    await p.current();
    await p.current();
    expect(calls).toBe(1); // served from cache, not re-acquired
  });

  test("re-acquires when within the refresh margin of exp", async () => {
    let t = 0;
    let n = 0;
    const p = cachingGrantProvider({
      acquire: () => grantExpiring(t + 100, `g${n++}`),
      now: () => t,
      refreshMarginMs: 50,
    });
    const a = await p.current(); // exp=100, now=0 → fresh (0 < 100-50)
    t = 60; // now within the 50ms margin of exp=100
    const b = await p.current(); // → re-acquire
    expect(a.signature).toBe("g0");
    expect(b.signature).toBe("g1");
  });

  test("dedupes concurrent callers to a single acquire", async () => {
    let calls = 0;
    const p = cachingGrantProvider({
      acquire: async () => {
        calls++;
        await Promise.resolve();
        return grantExpiring(100_000);
      },
      now: () => 0,
    });
    await Promise.all([p.current(), p.current(), p.current()]);
    expect(calls).toBe(1);
  });

  test("a failed acquire rejects and clears in-flight so a retry re-acquires", async () => {
    let calls = 0;
    const p = cachingGrantProvider({
      acquire: () => {
        calls++;
        if (calls === 1) throw new Error("acquire-failed");
        return grantExpiring(100_000);
      },
      now: () => 0,
    });
    await expect(p.current()).rejects.toThrow("acquire-failed");
    const g = await p.current(); // retry — in-flight was cleared, cache not poisoned
    expect(g.signature).toBe("g");
    expect(calls).toBe(2);
  });
});
