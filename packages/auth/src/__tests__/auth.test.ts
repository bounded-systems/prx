import { afterEach, describe, expect, test } from "bun:test";
import { authToken, requireAuthToken } from "@bounded-systems/auth";

afterEach(() => {
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
});

describe("@bounded-systems/auth", () => {
  test("github token resolves with GH_TOKEN precedence over GITHUB_TOKEN", () => {
    expect(authToken("github")).toBeNull();
    process.env.GITHUB_TOKEN = "ghp_b";
    expect(authToken("github")).toBe("ghp_b");
    process.env.GH_TOKEN = "ghp_a";
    expect(authToken("github")).toBe("ghp_a");
  });

  test("requireAuthToken throws when no credential is configured", () => {
    expect(() => requireAuthToken("github")).toThrow(/credential/);
    process.env.GH_TOKEN = "ghp_a";
    expect(requireAuthToken("github")).toBe("ghp_a");
  });

  test("notion token resolves from NOTION_TOKEN", () => {
    const env = { NOTION_TOKEN: "secret_x" } as NodeJS.ProcessEnv;
    expect(authToken("notion", env)).toBe("secret_x");
    expect(authToken("notion", {} as NodeJS.ProcessEnv)).toBeNull();
  });

  test("slack token resolves with SLACK_BOT_TOKEN precedence over SLACK_TOKEN", () => {
    // root authority for the slack keymaker (epic prx-zes); bot token wins.
    expect(authToken("slack", {} as NodeJS.ProcessEnv)).toBeNull();
    expect(authToken("slack", { SLACK_TOKEN: "xoxb_generic" } as NodeJS.ProcessEnv)).toBe(
      "xoxb_generic",
    );
    const both = {
      SLACK_TOKEN: "xoxb_generic",
      SLACK_BOT_TOKEN: "xoxb_bot",
    } as NodeJS.ProcessEnv;
    expect(authToken("slack", both)).toBe("xoxb_bot");
  });

  test("an injected env is read instead of the ambient environment", () => {
    // process.env has no token, but the injected env does — proves the seam.
    expect(authToken("github")).toBeNull();
    const injected = { GITHUB_TOKEN: "ghp_injected" } as NodeJS.ProcessEnv;
    expect(authToken("github", injected)).toBe("ghp_injected");
  });
});
