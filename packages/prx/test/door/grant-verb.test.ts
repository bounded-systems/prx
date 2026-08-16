import { describe, expect, test } from "bun:test";

import { buildKeeperAuthorizer } from "../../src/keeperd/grant-gate.ts";
import { issuerKeys, type MintGrantInput } from "../../src/door/grant-issuer.ts";
import { doorGrantVerb, doorIssuerKeysVerb } from "../../src/door/grant-verb.ts";

describe("doorIssuerKeysVerb", () => {
  test("emits the published IssuerKeys for the default actor (real deps)", async () => {
    const result = await doorIssuerKeysVerb.run({ actor: "door-authority" });
    expect(result.keys).toHaveLength(1);
    expect(result.keys[0]!.publicKeyPem).toContain("BEGIN PUBLIC KEY");
    // Matches what the issuer module publishes for the same actor.
    expect(result.keys[0]!.kid).toBe(issuerKeys("door-authority").keys[0]!.kid);
  });
});

describe("doorGrantVerb", () => {
  test("mints a grant the keeper gate accepts (real deps: Date.now + randomUUID)", async () => {
    const result = await doorGrantVerb.run({
      door: "keeper",
      audience: "claude-room",
      ttl: 60,
      actor: "door-authority",
    });
    expect(result.door).toBe("keeper");
    expect(result.audience).toBe("claude-room");
    expect(result.expiresAt).toBeGreaterThan(0);
    // End-to-end: the verb's freshly minted grant verifies at the keeper gate.
    const authorize = buildKeeperAuthorizer({ keys: issuerKeys(), audience: "claude-room" });
    expect(authorize({ id: "1", method: "import-and-push", grant: result.grant as never })).toBe(
      true,
    );
  });

  test("forwards door/audience/ttl/nonce to the mint seam and reports expiry (injected deps)", async () => {
    const calls: MintGrantInput[] = [];
    const result = await doorGrantVerb.run(
      { door: "keeper", audience: "room-x", ttl: 30, actor: "door-authority" },
      {
        mint: (input) => {
          calls.push(input);
          return { signature: "sig" } as never;
        },
        now: () => 1_000,
        nonce: () => "fixed-nonce",
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      door: "keeper",
      audience: "room-x",
      ttlSeconds: 30,
      nonce: "fixed-nonce",
      now: 1_000,
    });
    // expiresAt = now + ttl*1000.
    expect(result.expiresAt).toBe(1_000 + 30 * 1_000);
  });
});
