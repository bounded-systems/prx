// Checks for resolveKeeperTrustKey (Phase B.2): the keeper trust key is
// operator-supplied and fail-closed — never derived from the actor.
import { describe, test, expect } from "bun:test";

import { resolveKeeperTrustKey } from "../../src/provenance/keeper-trust.ts";

const PEM = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA...\n-----END PUBLIC KEY-----\n";
const envOf =
  (vals: Record<string, string | undefined>) =>
  (k: string): string | undefined =>
    vals[k];

describe("resolveKeeperTrustKey", () => {
  test("returns null when PRX_KEEPER_PUBKEY is unset (fail closed)", () => {
    expect(resolveKeeperTrustKey(envOf({}))).toBeNull();
  });

  test("returns null for an empty value (fail closed)", () => {
    expect(resolveKeeperTrustKey(envOf({ PRX_KEEPER_PUBKEY: "  " }))).toBeNull();
  });

  test("accepts a PEM literal", () => {
    expect(resolveKeeperTrustKey(envOf({ PRX_KEEPER_PUBKEY: PEM }))).toBe(PEM);
  });

  test("reads a PEM from a path", () => {
    const read = (p: string) => (p === "/keys/keeper.pem" ? PEM : "nope");
    expect(resolveKeeperTrustKey(envOf({ PRX_KEEPER_PUBKEY: "/keys/keeper.pem" }), read)).toBe(PEM);
  });

  test("fails closed when the path holds a non-PEM", () => {
    const read = () => "not a pem";
    expect(resolveKeeperTrustKey(envOf({ PRX_KEEPER_PUBKEY: "/keys/bad" }), read)).toBeNull();
  });

  test("fails closed when the path is unreadable", () => {
    const read = () => {
      throw new Error("ENOENT");
    };
    expect(resolveKeeperTrustKey(envOf({ PRX_KEEPER_PUBKEY: "/missing" }), read)).toBeNull();
  });
});
