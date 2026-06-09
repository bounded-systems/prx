import { describe, expect, test } from "bun:test";
import {
  slackScopedKeymaker,
  SlackReadError,
  type BaseKeymaker,
  type SlackKeyScope,
} from "@bounded-systems/slack";

// A fake base keymaker — no secret, no auth. Proves the slack scope layer never
// needs the credential package: it wraps a structurally-typed base whose
// authorize() stands in for bearer injection.
function fakeBase(clock: { t: number }): BaseKeymaker {
  return {
    mint({ ttlMs, keyId }) {
      const expiresAt = clock.t + ttlMs;
      return {
        keyId: keyId ?? "base-key",
        expiresAt,
        authorize(req) {
          return {
            ...req,
            headers: { ...(req.headers ?? {}), Authorization: "Bearer FAKE" },
          };
        },
      };
    },
  };
}

const HISTORY_SCOPE: SlackKeyScope = { ops: ["history"], channels: ["C123"] };

describe("slackScopedKeymaker", () => {
  test("surfaces keyId/scope/expiresAt from the base credential + grant", () => {
    const clock = { t: 1_000 };
    const km = slackScopedKeymaker(fakeBase(clock), { now: () => clock.t });
    const key = km.mint({ scope: HISTORY_SCOPE, ttlMs: 500 });
    expect(key.keyId).toBe("base-key");
    expect(key.scope).toEqual(HISTORY_SCOPE);
    expect(key.expiresAt).toBe(1_500);
  });

  test("authorizes an in-scope op + channel, delegating injection to the base", () => {
    const clock = { t: 0 };
    const km = slackScopedKeymaker(fakeBase(clock), { now: () => clock.t });
    const key = km.mint({ scope: HISTORY_SCOPE, ttlMs: 1_000 });
    const out = key.authorize({ op: "history", channel: "C123" }, { url: "/history" });
    expect(out.headers.Authorization).toBe("Bearer FAKE");
    expect(out.url).toBe("/history");
  });

  test("refuses an op outside the key's scope (SCOPE_DENIED)", () => {
    const clock = { t: 0 };
    const km = slackScopedKeymaker(fakeBase(clock), { now: () => clock.t });
    const key = km.mint({ scope: HISTORY_SCOPE, ttlMs: 1_000 });
    expect(() => key.authorize({ op: "users" }, {})).toThrow(SlackReadError);
    try {
      key.authorize({ op: "users" }, {});
    } catch (e) {
      expect((e as SlackReadError).code).toBe("SCOPE_DENIED");
    }
  });

  test("refuses a channel outside the key's scope (SCOPE_DENIED)", () => {
    const clock = { t: 0 };
    const km = slackScopedKeymaker(fakeBase(clock), { now: () => clock.t });
    const key = km.mint({ scope: HISTORY_SCOPE, ttlMs: 1_000 });
    try {
      key.authorize({ op: "history", channel: "C999" }, {});
      throw new Error("expected throw");
    } catch (e) {
      expect((e as SlackReadError).code).toBe("SCOPE_DENIED");
    }
  });

  test("channel-less ops pass when a channel scope is set (no channel to constrain)", () => {
    const clock = { t: 0 };
    const scope: SlackKeyScope = { ops: ["users", "channels"], channels: ["C123"] };
    const km = slackScopedKeymaker(fakeBase(clock), { now: () => clock.t });
    const key = km.mint({ scope, ttlMs: 1_000 });
    expect(() => key.authorize({ op: "users" }, {})).not.toThrow();
  });

  test("an undefined channel scope allows any channel", () => {
    const clock = { t: 0 };
    const scope: SlackKeyScope = { ops: ["history"] };
    const km = slackScopedKeymaker(fakeBase(clock), { now: () => clock.t });
    const key = km.mint({ scope, ttlMs: 1_000 });
    expect(() => key.authorize({ op: "history", channel: "C-any" }, {})).not.toThrow();
  });

  test("expiry is checked before scope and yields KEY_EXPIRED", () => {
    const clock = { t: 0 };
    const km = slackScopedKeymaker(fakeBase(clock), { now: () => clock.t });
    const key = km.mint({ scope: HISTORY_SCOPE, ttlMs: 100 }); // expiresAt = 100
    clock.t = 100;
    // even an out-of-scope op reports expiry first, proving order
    try {
      key.authorize({ op: "users" }, {});
      throw new Error("expected throw");
    } catch (e) {
      expect((e as SlackReadError).code).toBe("KEY_EXPIRED");
    }
  });

  // ── org ⊃ channel ⊃ thread capability dimensions (prx-q7r) ────────────────

  test("org-scoped key: refuses a read targeting a different workspace", () => {
    const clock = { t: 0 };
    const scope: SlackKeyScope = { ops: ["history"], orgs: ["T1"] };
    const km = slackScopedKeymaker(fakeBase(clock), { now: () => clock.t });
    const key = km.mint({ scope, ttlMs: 1_000 });
    // same org → allowed (and any channel within it, since channels is undefined)
    expect(() =>
      key.authorize({ op: "history", org: "T1", channel: "C-any" }, {}),
    ).not.toThrow();
    // different org → denied
    try {
      key.authorize({ op: "history", org: "T2", channel: "C-any" }, {});
      throw new Error("expected throw");
    } catch (e) {
      expect((e as SlackReadError).code).toBe("SCOPE_DENIED");
      expect((e as SlackReadError).message).toContain("org 'T2'");
    }
  });

  test("a read that declares no org passes an org-scoped key (undefined target unconstrained)", () => {
    const clock = { t: 0 };
    const scope: SlackKeyScope = { ops: ["history"], orgs: ["T1"] };
    const km = slackScopedKeymaker(fakeBase(clock), { now: () => clock.t });
    const key = km.mint({ scope, ttlMs: 1_000 });
    expect(() => key.authorize({ op: "history", channel: "C1" }, {})).not.toThrow();
  });

  test("thread-scoped key: pins op + channel + thread, refusing another thread", () => {
    const clock = { t: 0 };
    const scope: SlackKeyScope = { ops: ["thread"], channels: ["C1"], threads: ["169.1"] };
    const km = slackScopedKeymaker(fakeBase(clock), { now: () => clock.t });
    const key = km.mint({ scope, ttlMs: 1_000 });
    expect(() =>
      key.authorize({ op: "thread", channel: "C1", thread: "169.1" }, {}),
    ).not.toThrow();
    try {
      key.authorize({ op: "thread", channel: "C1", thread: "999.9" }, {});
      throw new Error("expected throw");
    } catch (e) {
      expect((e as SlackReadError).code).toBe("SCOPE_DENIED");
      expect((e as SlackReadError).message).toContain("thread '999.9'");
    }
  });

  test("an org-only grant authorizes every channel + thread within it (org ⊃ channel ⊃ thread)", () => {
    const clock = { t: 0 };
    const scope: SlackKeyScope = { ops: ["thread"], orgs: ["T1"] };
    const km = slackScopedKeymaker(fakeBase(clock), { now: () => clock.t });
    const key = km.mint({ scope, ttlMs: 1_000 });
    expect(() =>
      key.authorize({ op: "thread", org: "T1", channel: "C-whatever", thread: "1.2" }, {}),
    ).not.toThrow();
  });
});
