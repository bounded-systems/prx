// pr-state/overview-verb — the slug-resolution error arms (no index config, no
// inventory index). The happy paths live in overview-verb.test.ts.

import { describe, expect, test } from "bun:test";

import { overviewVerb, type OverviewDeps } from "../../src/pr-state/overview-verb.ts";

const baseInput = {
  slug: "some-slug",
  "repo-path": ".",
  format: "plain" as const,
  "include-diff-stats": true,
};
const run = (deps: OverviewDeps) => overviewVerb.run(baseInput as never, deps);

describe("overviewVerb — slug resolution errors", () => {
  test("throws when no `.prx/repos/index.json` resolves from cwd", () => {
    const deps = {
      loadRepoInventoryConfig: () => ({ indexPath: null }),
      loadRepoInventoryIndex: () => null,
      overviewStatus: (() => ({})) as never,
    } as never as OverviewDeps;
    expect(() => run(deps)).toThrow(/index\.json/);
  });

  test("throws when the inventory index is missing", () => {
    const deps = {
      loadRepoInventoryConfig: () => ({ indexPath: "/some/index.json" }),
      loadRepoInventoryIndex: () => null,
      overviewStatus: (() => ({})) as never,
    } as never as OverviewDeps;
    expect(() => run(deps)).toThrow(/inventory index/);
  });
});
