import { describe, expect, test } from "bun:test";

import { GithubResolver } from "../../../src/pr-state/resolvers/github.ts";
import type { CommandRunner } from "../../../src/pr-state/github.ts";

function mockRunner(fixtures: Record<string, { stdout: string; status: number }>): CommandRunner {
  return (cmd: string[]) => {
    const key = cmd.join(" ");
    for (const [pattern, response] of Object.entries(fixtures)) {
      if (key.includes(pattern)) {
        return { status: response.status, stdout: response.stdout, stderr: "" };
      }
    }
    throw new Error(`unexpected command: ${key}`);
  };
}

describe("GithubResolver", () => {
  test("fetch returns a ResolvedWorkUnit for an open issue", async () => {
    const runner = mockRunner({
      "git rev-parse --show-toplevel": { status: 0, stdout: "/tmp/repo\n" },
      "gh repo view --json nameWithOwner": {
        status: 0,
        stdout: "owner/repo\n",
      },
      "gh issue view 42": {
        status: 0,
        stdout: JSON.stringify({
          number: 42,
          title: "An example issue",
          state: "OPEN",
          body: "Issue body text",
          url: "https://github.com/owner/repo/issues/42",
        }),
      },
    });
    const resolver = new GithubResolver("/tmp/repo");
    const resolved = await resolver.fetch("GH-42", { runner });
    expect(resolved).toEqual({
      id: "GH-42",
      title: "An example issue",
      body: "Issue body text",
      state: "open",
      url: "https://github.com/owner/repo/issues/42",
      source: "github",
    });
  });

  test("fetch marks a closed issue as closed", async () => {
    const runner = mockRunner({
      "git rev-parse --show-toplevel": { status: 0, stdout: "/tmp/repo\n" },
      "gh repo view --json nameWithOwner": {
        status: 0,
        stdout: "owner/repo\n",
      },
      "gh issue view 7": {
        status: 0,
        stdout: JSON.stringify({ number: 7, title: "t", state: "CLOSED", body: "", url: "" }),
      },
    });
    const resolver = new GithubResolver("/tmp/repo");
    const resolved = await resolver.fetch("GH-7", { runner });
    expect(resolved.state).toBe("closed");
  });

  test("fetch rejects a non-GH canonical id", async () => {
    const resolver = new GithubResolver("/tmp/repo");
    await expect(resolver.fetch("PROJECT-6688")).rejects.toThrow(/requires a GH-<n>/);
  });
});
