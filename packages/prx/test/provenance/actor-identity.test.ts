/**
 * prx-keymaker: per-actor signing identity — the pure, secretless foundation.
 *
 * The contract these tests pin:
 *   - identity = <actor>@<digest> where the digest hashes the AUTHORITY CONTRACT
 *     (sorted, canonical) — so it is stable, order-independent, and changes iff
 *     the actor's powers change.
 *   - the keypair is a deterministic KDF of (master secret, identity): same
 *     inputs → same key; rotated identity → different key from the SAME secret.
 *   - the trust map carries only PUBLIC material, one distinct key per actor.
 */
import { describe, expect, test } from "bun:test";

import {
  type ActorAuthorityContract,
  actorAuthorityContract,
  actorIdentity,
  buildActorTrustMap,
  deriveActorKeypair,
  digestOfContract,
} from "../../src/provenance/actor-identity.ts";

const baseContract = (): ActorAuthorityContract => ({
  actor: "keeper",
  binding: "work-unit",
  allowedTools: ["Bash(prx tools git:*)", "Edit"],
  disallowedTools: ["Bash(git push --force:*)"],
  allowedActors: ["git", "prx"],
  disallowedActors: ["gmail"],
  allowedDispatchTargets: ["submit"],
});

describe("actor identity digest (prx-keymaker)", () => {
  test("digest is canonical — array order does not change it", () => {
    const a = digestOfContract(baseContract());
    const b = digestOfContract({
      ...baseContract(),
      allowedTools: ["Edit", "Bash(prx tools git:*)"], // reordered
      allowedActors: ["prx", "git"], // reordered
    });
    expect(a).toBe(b);
  });

  test("digest CHANGES when an authority field changes (widened tools)", () => {
    const before = digestOfContract(baseContract());
    const widened = digestOfContract({
      ...baseContract(),
      allowedTools: [...baseContract().allowedTools, "Bash(gh pr merge:*)"],
    });
    expect(widened).not.toBe(before);
  });

  test("real actors have stable, distinct identities", () => {
    expect(actorIdentity("plan")).toBe(actorIdentity("plan")); // deterministic
    expect(actorIdentity("plan")).not.toBe(actorIdentity("implement"));
    expect(actorIdentity("implement")).toMatch(/^implement@[0-9a-f]{12}$/);
  });

  test("the contract excludes the banner (docs), includes the allow/deny lists", () => {
    const c = actorAuthorityContract("implement");
    expect(c).not.toHaveProperty("banner");
    expect(Array.isArray(c.allowedTools)).toBe(true);
    expect(Array.isArray(c.allowedDispatchTargets)).toBe(true);
  });
});

describe("actor keypair KDF (prx-keymaker)", () => {
  const master = Buffer.from("deployment-master-secret-32-bytes!!", "utf8");

  test("deterministic: same (secret, identity) → same key", () => {
    const a = deriveActorKeypair(master, "keeper@abc123");
    const b = deriveActorKeypair(master, "keeper@abc123");
    expect(a.keyid).toBe(b.keyid);
    expect(a.pointBase64).toBe(b.pointBase64);
  });

  test("rotation: a different identity → a different key from the SAME secret", () => {
    const v1 = deriveActorKeypair(master, "keeper@aaaaaaaaaaaa");
    const v2 = deriveActorKeypair(master, "keeper@bbbbbbbbbbbb");
    expect(v2.keyid).not.toBe(v1.keyid);
  });

  test("isolation: a different secret → a different key for the same identity", () => {
    const other = Buffer.from("a-different-master-secret-entirely!!", "utf8");
    const a = deriveActorKeypair(master, "keeper@abc123");
    const b = deriveActorKeypair(other, "keeper@abc123");
    expect(b.keyid).not.toBe(a.keyid);
  });
});

describe("trust map (the secretless keymaker register)", () => {
  test("one distinct public entry per actor; no private material", () => {
    const master = Buffer.from("deployment-master-secret-32-bytes!!", "utf8");
    const map = buildActorTrustMap(master);

    expect(Object.keys(map).sort()).toEqual(
      ["author", "implement", "intake", "plan", "scratch", "submit", "triage"].sort(),
    );
    // every entry is public-only: identity + keyid + ed25519:<pub>
    for (const entry of Object.values(map)) {
      expect(entry.pubkey).toMatch(/^ed25519:/);
      expect(JSON.stringify(entry)).not.toContain("PRIVATE");
    }
    // distinct keys per actor
    const pubs = Object.values(map).map((e) => e.pubkey);
    expect(new Set(pubs).size).toBe(pubs.length);
  });
});
