import { describe, expect, test } from "bun:test";

import type { RequestEnvelope } from "@bounded-systems/guest-room/protocol";

import {
  DEFAULT_GRANT_ISSUER_ACTOR,
  issuerKeys,
  mintDoorGrant,
  resolveGrantIssuer,
} from "../../src/door/grant-issuer.ts";
import { buildKeeperAuthorizer } from "../../src/keeperd/grant-gate.ts";

// Mint + verify both derive from the provenance master (zero-config dev seed),
// so the loop is deterministic without any key wiring.
const AUDIENCE = "claude-room";
const now = Date.now();

function req(grant: unknown): RequestEnvelope {
  return { id: "1", method: "import-and-push", params: {}, grant: grant as never };
}

describe("door grant issuer ↔ keeper gate (prx-8uf2, end-to-end)", () => {
  // The door is configured with THIS issuer's published keys.
  const gate = { keys: issuerKeys(), audience: AUDIENCE };
  const authorize = buildKeeperAuthorizer(gate);

  test("a freshly minted keeper grant is ACCEPTED by the keeper gate", () => {
    const grant = mintDoorGrant({
      door: "keeper",
      audience: AUDIENCE,
      ttlSeconds: 60,
      nonce: "n1",
      now,
    });
    expect(authorize(req(grant))).toBe(true);
  });

  test("an expired grant is rejected", () => {
    const grant = mintDoorGrant({
      door: "keeper",
      audience: AUDIENCE,
      ttlSeconds: 60,
      nonce: "n2",
      now: now - 120_000, // exp = now-60s, already in the past
    });
    expect(authorize(req(grant))).toBe(false);
  });

  test("a grant for a different audience is rejected", () => {
    const grant = mintDoorGrant({
      door: "keeper",
      audience: "someone-else",
      ttlSeconds: 60,
      nonce: "n3",
      now,
    });
    expect(authorize(req(grant))).toBe(false);
  });

  test("a grant minted for a different door is rejected by the keeper gate", () => {
    const grant = mintDoorGrant({
      door: "forge",
      audience: AUDIENCE,
      ttlSeconds: 60,
      nonce: "n4",
      now,
    });
    expect(authorize(req(grant))).toBe(false);
  });

  test("a grant from a DIFFERENT issuer actor is rejected (unknown key)", () => {
    // The gate trusts only the door-authority's keys; a grant signed by another
    // actor names an issuer kid the door has never published.
    const grant = mintDoorGrant({
      door: "keeper",
      audience: AUDIENCE,
      ttlSeconds: 60,
      nonce: "n5",
      now,
      actor: "some-other-actor",
    });
    expect(authorize(req(grant))).toBe(false);
  });
});

describe("issuerKeys / resolveGrantIssuer", () => {
  test("publishes a stable kid + an SPKI PEM public key", () => {
    const a = issuerKeys();
    const b = issuerKeys();
    expect(a.keys).toHaveLength(1);
    expect(a.keys[0]!.kid).toBe(b.keys[0]!.kid); // deterministic (same master)
    expect(a.keys[0]!.publicKeyPem).toContain("BEGIN PUBLIC KEY");
  });

  test("the published kid matches the kid bound into a minted grant", () => {
    const issuer = resolveGrantIssuer(DEFAULT_GRANT_ISSUER_ACTOR);
    const grant = mintDoorGrant({
      door: "keeper",
      audience: AUDIENCE,
      ttlSeconds: 60,
      nonce: "n6",
      now,
    });
    expect((grant as { binding: { keyId: string } }).binding.keyId).toBe(issuer.kid);
    expect(issuerKeys().keys[0]!.kid).toBe(issuer.kid);
  });

  test("different actors derive different issuer keys", () => {
    expect(issuerKeys("door-authority").keys[0]!.kid).not.toBe(
      issuerKeys("some-other-actor").keys[0]!.kid,
    );
  });
});
