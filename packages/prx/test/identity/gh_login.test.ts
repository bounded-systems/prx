import { afterEach, describe, expect, test } from "bun:test";

import { resetGhLoginCacheForTests, resolveGhLogin } from "../../src/identity/gh_login.ts";

afterEach(() => {
  resetGhLoginCacheForTests();
});

describe("resolveGhLogin (GH-2012)", () => {
  test("auth ok + api returns login → ok with trimmed login", () => {
    const result = resolveGhLogin({
      runGhAuthStatus: () => ({ ok: true }),
      runGhApiUserLogin: () => "bdelanghe",
    });
    expect(result).toEqual({ ok: true, login: "bdelanghe" });
  });

  test("auth status non-zero → refuse with named message, no fallback", () => {
    const result = resolveGhLogin({
      runGhAuthStatus: () => ({ ok: false }),
      runGhApiUserLogin: () => {
        throw new Error("api should not be consulted when auth fails");
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/gh auth status/);
      expect(result.message).toMatch(/gh auth login/);
    }
  });

  test("api returns null → refuse", () => {
    const result = resolveGhLogin({
      runGhAuthStatus: () => ({ ok: true }),
      runGhApiUserLogin: () => null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/no login/);
    }
  });

  test("api returns empty string → refuse", () => {
    const result = resolveGhLogin({
      runGhAuthStatus: () => ({ ok: true }),
      runGhApiUserLogin: () => "",
    });
    expect(result.ok).toBe(false);
  });

  test("cache: second call does not re-spawn gh", () => {
    let authCalls = 0;
    let apiCalls = 0;
    const deps = {
      runGhAuthStatus: () => {
        authCalls++;
        return { ok: true };
      },
      runGhApiUserLogin: () => {
        apiCalls++;
        return "bdelanghe";
      },
    };
    const first = resolveGhLogin(deps);
    const second = resolveGhLogin(deps);
    expect(first).toEqual({ ok: true, login: "bdelanghe" });
    expect(second).toEqual({ ok: true, login: "bdelanghe" });
    expect(authCalls).toBe(1);
    expect(apiCalls).toBe(1);
  });

  test("resetGhLoginCacheForTests clears the cache", () => {
    let apiCalls = 0;
    const deps = {
      runGhAuthStatus: () => ({ ok: true }),
      runGhApiUserLogin: () => {
        apiCalls++;
        return "bdelanghe";
      },
    };
    resolveGhLogin(deps);
    resetGhLoginCacheForTests();
    resolveGhLogin(deps);
    expect(apiCalls).toBe(2);
  });
});
