import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";

import {
  signGrant,
  tcp,
  unix,
  type DoorGrant,
  type GrantBinding,
  type IssuerKeys,
  type SignedGrant,
} from "@bounded-systems/guest-room";
import type { RequestEnvelope } from "@bounded-systems/guest-room/protocol";

import {
  buildKeeperAuthorizer,
  ed25519VerifyWith,
  resolveKeeperGrantGate,
} from "../../src/keeperd/grant-gate.ts";

// ── A test issuer: a real ed25519 keypair, published as IssuerKeys ───────────
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const KID = "test-issuer-1";
const keys: IssuerKeys = { keys: [{ kid: KID, publicKeyPem }] };
const sign = (data: string): string =>
  cryptoSign(null, Buffer.from(data, "utf8"), privateKey).toString("base64");

const AUDIENCE = "claude-room";

const baseGrant: DoorGrant = {
  name: "keeper",
  host: unix("/run/prx/doors/keeperd.sock"),
  guest: tcp("127.0.0.1", 9999),
  env: "KEEPERD_SOCK",
  grants: "git push via keeperd",
  use: "present this grant to lease a push",
};

function mint(
  opts: { door?: string; audience?: string; exp?: number; kid?: string } = {},
): SignedGrant {
  const grant: DoorGrant = { ...baseGrant, name: opts.door ?? "keeper" };
  const binding: GrantBinding = {
    audience: opts.audience ?? AUDIENCE,
    exp: opts.exp ?? Date.now() + 60_000,
    nonce: "nonce-1",
    keyId: opts.kid ?? KID,
  };
  return signGrant(grant, binding, sign);
}

function req(grant?: SignedGrant): RequestEnvelope {
  return { id: "1", method: "import-and-push", params: {}, ...(grant ? { grant } : {}) };
}

describe("ed25519VerifyWith", () => {
  test("verifies a genuine signature and rejects a tampered one / bad key", () => {
    const data = "payload";
    const sig = sign(data);
    expect(ed25519VerifyWith(data, sig, publicKeyPem)).toBe(true);
    expect(ed25519VerifyWith("payload-x", sig, publicKeyPem)).toBe(false);
    // A malformed PEM must DENY (false), never throw.
    expect(ed25519VerifyWith(data, sig, "not-a-pem")).toBe(false);
  });
});

describe("buildKeeperAuthorizer (the keeper TCP gate)", () => {
  const authorize = buildKeeperAuthorizer({ keys, audience: AUDIENCE });

  test("accepts a valid grant minted for the keeper door + our audience", () => {
    expect(authorize(req(mint()))).toBe(true);
  });

  test("rejects a request with no grant at all", () => {
    expect(authorize(req())).toBe(false);
  });

  test("rejects a grant minted for a DIFFERENT door (audience confusion)", () => {
    expect(authorize(req(mint({ door: "ghapp" })))).toBe(false);
  });

  test("rejects a grant bound to a different audience", () => {
    expect(authorize(req(mint({ audience: "someone-else" })))).toBe(false);
  });

  test("rejects an expired grant", () => {
    expect(authorize(req(mint({ exp: Date.now() - 1000 })))).toBe(false);
  });

  test("rejects a grant naming an unknown issuer key id", () => {
    expect(authorize(req(mint({ kid: "no-such-kid" })))).toBe(false);
  });

  test("rejects a grant whose signature was tampered after minting", () => {
    const g = mint();
    expect(authorize(req({ ...g, signature: sign("forged-bytes") }))).toBe(false);
  });
});

describe("resolveKeeperGrantGate", () => {
  const env = (vars: Record<string, string>) => (k: string) => vars[k];

  test("null when neither audience nor keys are set", () => {
    expect(resolveKeeperGrantGate({ env: env({}) })).toBeNull();
  });

  test("null when only one of the two is set (misconfiguration)", () => {
    expect(resolveKeeperGrantGate({ env: env({ KEEPERD_GRANT_AUDIENCE: AUDIENCE }) })).toBeNull();
    expect(
      resolveKeeperGrantGate({ env: env({ KEEPERD_ISSUER_KEYS: JSON.stringify(keys) }) }),
    ).toBeNull();
  });

  test("parses inline JSON issuer keys + audience", () => {
    const gate = resolveKeeperGrantGate({
      env: env({ KEEPERD_GRANT_AUDIENCE: AUDIENCE, KEEPERD_ISSUER_KEYS: JSON.stringify(keys) }),
    });
    expect(gate).not.toBeNull();
    expect(gate!.audience).toBe(AUDIENCE);
    expect(gate!.keys.keys[0]!.kid).toBe(KID);
  });

  test("reads issuer keys from an @<path> via the injected readFile", () => {
    const gate = resolveKeeperGrantGate({
      env: env({ KEEPERD_GRANT_AUDIENCE: AUDIENCE, KEEPERD_ISSUER_KEYS: "@/keys.json" }),
      readFile: (p) => (p === "/keys.json" ? JSON.stringify(keys) : ""),
    });
    expect(gate!.keys.keys[0]!.publicKeyPem).toBe(publicKeyPem);
  });

  test("throws on malformed issuer-keys JSON", () => {
    expect(() =>
      resolveKeeperGrantGate({
        env: env({ KEEPERD_GRANT_AUDIENCE: AUDIENCE, KEEPERD_ISSUER_KEYS: "{not json" }),
      }),
    ).toThrow();
  });
});
