import { describe, expect, test } from "bun:test";
import { createServiceKeymaker, CredentialExpiredError } from "@bounded-systems/auth";

const ENV = { SLACK_BOT_TOKEN: "xoxb_root" } as NodeJS.ProcessEnv;

describe("createServiceKeymaker", () => {
  test("throws immediately when no credential is configured (fail fast)", () => {
    expect(() => createServiceKeymaker("slack", { env: {} as NodeJS.ProcessEnv })).toThrow(
      /credential/,
    );
  });

  test("mint stamps expiresAt = mintedAt + ttl from the injected clock", () => {
    const km = createServiceKeymaker("slack", { env: ENV, now: () => 1_000 });
    const key = km.mint({ ttlMs: 500 });
    expect(key.expiresAt).toBe(1_500);
  });

  test("authorize injects a bearer header from the sealed root token", () => {
    const km = createServiceKeymaker("slack", { env: ENV, now: () => 0 });
    const key = km.mint({ ttlMs: 1_000 });
    const out = key.authorize({ url: "https://slack.com/api/conversations.list" });
    expect(out.headers.Authorization).toBe("Bearer xoxb_root");
    expect(out.url).toBe("https://slack.com/api/conversations.list");
  });

  test("authorize preserves caller headers and adds Authorization", () => {
    const km = createServiceKeymaker("slack", { env: ENV, now: () => 0 });
    const key = km.mint({ ttlMs: 1_000 });
    const out = key.authorize({ headers: { "X-Trace": "abc" } });
    expect(out.headers).toEqual({ "X-Trace": "abc", Authorization: "Bearer xoxb_root" });
  });

  test("authorize throws CredentialExpiredError once the clock passes expiry", () => {
    let t = 0;
    const km = createServiceKeymaker("slack", { env: ENV, now: () => t });
    const key = km.mint({ ttlMs: 100 }); // expiresAt = 100
    t = 99;
    expect(() => key.authorize({})).not.toThrow();
    t = 100; // now >= expiresAt
    expect(() => key.authorize({})).toThrow(CredentialExpiredError);
  });

  test("the root token is never exposed as a property of the key", () => {
    const km = createServiceKeymaker("slack", { env: ENV, now: () => 0 });
    const key = km.mint({ ttlMs: 1_000 });
    // capability surface is exactly { keyId, expiresAt, authorize } — no token.
    expect(Object.keys(key).sort()).toEqual(["authorize", "expiresAt", "keyId"]);
    expect(JSON.stringify(key)).not.toContain("xoxb_root");
  });

  test("keyId honors an explicit id, else the injected generator, else a default", () => {
    const explicit = createServiceKeymaker("slack", { env: ENV, now: () => 7 });
    expect(explicit.mint({ ttlMs: 1, keyId: "fixed-id" }).keyId).toBe("fixed-id");

    const gen = createServiceKeymaker("slack", {
      env: ENV,
      now: () => 7,
      genKeyId: (mintedAt) => `gen-${mintedAt}`,
    });
    expect(gen.mint({ ttlMs: 1 }).keyId).toBe("gen-7");

    const def = createServiceKeymaker("slack", { env: ENV, now: () => 7 });
    expect(def.mint({ ttlMs: 1 }).keyId).toContain("slack-");
  });
});
