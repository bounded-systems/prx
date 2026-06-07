// triage/prioritize — runPrioritizeActor (audit-capturing wrapper) + the
// repo-resolution failure arms, driven without gh/bd or the interactive prompt.

import { describe, expect, test } from "bun:test";

import { runPrioritizeActor } from "../../src/triage/prioritize.ts";

const opts = { repo: undefined, limit: 0, dryRun: true, sync: false } as never;

describe("runPrioritizeActor — repo resolution failures", () => {
  test("a throwing repoNameWithOwner → exit 1", async () => {
    const r = await runPrioritizeActor(opts, {
      repoNameWithOwner: (() => {
        throw new Error("not a git repo");
      }) as never,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.join("\n")).toContain("failed to resolve repo");
  });

  test("an unresolved repo → exit 1 with the --repo hint", async () => {
    const r = await runPrioritizeActor(opts, {
      repoNameWithOwner: (() => "") as never,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.join("\n")).toContain("--repo is required");
  });
});
