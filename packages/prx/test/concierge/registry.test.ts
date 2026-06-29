import { describe, expect, test } from "bun:test";

import {
  DEFAULT_PROVIDER_LEASE_SECONDS,
  ProviderRegistry,
} from "../../src/concierge/registry.ts";

describe("ProviderRegistry", () => {
  test("register returns the lease ttl and makes the provider live", () => {
    const r = new ProviderRegistry();
    const { ttl } = r.register({ capability: "ghapp", door: "/run/ghappd.sock", lease: 120 }, 0);
    expect(ttl).toBe(120);
    expect(r.live("ghapp", 0).map((e) => e.door)).toEqual(["/run/ghappd.sock"]);
  });

  test("defaults the lease ttl and the env var name", () => {
    const r = new ProviderRegistry();
    const { ttl } = r.register({ capability: "scout", door: "/run/scoutd.sock" }, 0);
    expect(ttl).toBe(DEFAULT_PROVIDER_LEASE_SECONDS);
    expect(r.live("scout", 0)[0]!.env).toBe("SCOUT_SOCK");
  });

  test("an expired lease drops out of live + list", () => {
    const r = new ProviderRegistry();
    r.register({ capability: "ghapp", door: "/d.sock", lease: 60 }, 0); // exp = 60_000ms
    expect(r.live("ghapp", 59_000)).toHaveLength(1);
    expect(r.live("ghapp", 61_000)).toHaveLength(0);
    expect(r.list(61_000)).toHaveLength(0);
  });

  test("re-registering the same (capability,door) refreshes the lease", () => {
    const r = new ProviderRegistry();
    r.register({ capability: "ghapp", door: "/d.sock", lease: 60 }, 0); // exp 60_000
    r.register({ capability: "ghapp", door: "/d.sock", lease: 60 }, 50_000); // exp 110_000
    expect(r.live("ghapp", 61_000)).toHaveLength(1); // still live after the original exp
    // Still a single slot, not a duplicate.
    expect(r.live("ghapp", 61_000)).toHaveLength(1);
  });

  test("list counts live providers per capability", () => {
    const r = new ProviderRegistry();
    r.register({ capability: "ghapp", door: "/a.sock", grants: "gh app", lease: 100 }, 0);
    r.register({ capability: "ghapp", door: "/b.sock", lease: 100 }, 0);
    r.register({ capability: "keeper", door: "/k.sock", lease: 100 }, 0);
    const rows = r.list(0).sort((a, b) => a.capability.localeCompare(b.capability));
    expect(rows).toEqual([
      { capability: "ghapp", grants: "gh app", providers: 2 },
      { capability: "keeper", grants: "the keeper capability", providers: 1 },
    ]);
  });
});
