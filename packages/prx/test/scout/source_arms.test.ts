// scout/source — the fetch-failure arm of resolveWorkUnitSource and the plain
// render of runScoutSource (the json + no-resolver arms live in source.test.ts).

import { describe, expect, test } from "bun:test";

import type { ResolvedWorkUnit, WorkUnitResolver } from "../../src/pr-state/resolvers/types.ts";
import { resolveWorkUnitSource, runScoutSource, ScoutSourceError } from "../../src/scout/source.ts";

const unit = (over: Partial<ResolvedWorkUnit> = {}): ResolvedWorkUnit => ({
  id: "GH-1",
  source: "github",
  title: "A unit",
  state: "open",
  url: "https://github.com/o/r/issues/1",
  body: "body",
  ...over,
});

const resolver = (impl: () => Promise<ResolvedWorkUnit>): WorkUnitResolver =>
  ({ name: "github", fetch: impl }) as WorkUnitResolver;

function rec() {
  const lines: string[] = [];
  return {
    lines,
    output: { log: (l: string) => lines.push(l), error: (l: string) => lines.push(l) },
  };
}

describe("resolveWorkUnitSource — fetch failure", () => {
  test("wraps a resolver fetch error in a ScoutSourceError naming the resolver", async () => {
    await expect(
      resolveWorkUnitSource("GH-9", {
        buildResolver: (() =>
          resolver(async () => {
            throw new Error("boom");
          })) as never,
      }),
    ).rejects.toThrow(ScoutSourceError);
  });
});

describe("runScoutSource — plain output", () => {
  test("prints `source: title [state]` and the url line", async () => {
    const r = rec();
    const code = await runScoutSource({ id: "GH-1", format: "plain" } as never, r.output, {
      loadIdentity: (() => ({})) as never,
      buildResolver: (() => resolver(async () => unit())) as never,
      repoPath: "/repo",
    } as never);
    expect(code).toBe(0);
    const text = r.lines.join("\n");
    expect(text).toContain("github: A unit [open]");
    expect(text).toContain("https://github.com/o/r/issues/1");
  });

  test("omits the url line when the resolved unit has none", async () => {
    const r = rec();
    await runScoutSource({ id: "GH-2", format: "plain" } as never, r.output, {
      loadIdentity: (() => ({})) as never,
      buildResolver: (() => resolver(async () => unit({ url: null }))) as never,
      repoPath: "/repo",
    } as never);
    expect(r.lines.join("\n")).not.toContain("http");
  });
});
