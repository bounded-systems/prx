// GH-232: scout owns the source FETCH (the gh/bd/notion reach). intake delegates
// to this and only pins the result. These cover the resolve + the verb output.
import { describe, expect, test } from "bun:test";

import type { ResolvedWorkUnit, WorkUnitResolver } from "../../src/pr-state/resolvers/types.ts";
import { resolveWorkUnitSource, runScoutSource, ScoutSourceError } from "../../src/scout/source.ts";

const unit = (overrides: Partial<ResolvedWorkUnit> = {}): ResolvedWorkUnit => ({
  id: "GH-232",
  title: "Promote source-pin to an intake actor before plan",
  body: "scout fetches, pin attenuates, plan consumes.",
  state: "open",
  url: "https://github.com/owner/repo/issues/232",
  source: "github",
  ...overrides,
});

const fakeResolver = (u: ResolvedWorkUnit): WorkUnitResolver => ({
  name: u.source,
  fetch: async () => u,
});

const sink = () => {
  const lines: string[] = [];
  return { out: { log: (l: string) => lines.push(l), error: (l: string) => lines.push(l) }, lines };
};

describe("scout source — the source FETCH (GH-232)", () => {
  test("resolveWorkUnitSource returns the resolved authority via the dispatched resolver", async () => {
    const resolved = await resolveWorkUnitSource("GH-232", {
      loadIdentity: (() => ({})) as never,
      buildResolver: (() => fakeResolver(unit())) as never,
      repoPath: "/repo",
    });
    expect(resolved.source).toBe("github");
    expect(resolved.title).toBe("Promote source-pin to an intake actor before plan");
  });

  test("runScoutSource json output carries the resolved fields (fetch only, no pin)", async () => {
    const { out, lines } = sink();
    const code = await runScoutSource({ id: "GH-232", format: "json" }, out, {
      loadIdentity: (() => ({})) as never,
      buildResolver: (() => fakeResolver(unit())) as never,
      repoPath: "/repo",
    });
    expect(code).toBe(0);
    const payload = JSON.parse(lines[0]!);
    expect(payload.unit).toBe("GH-232");
    expect(payload.source).toBe("github");
    expect(payload.title).toContain("intake actor");
  });

  test("throws ScoutSourceError when no resolver is configured", async () => {
    await expect(
      resolveWorkUnitSource("GH-999", {
        loadIdentity: (() => ({})) as never,
        buildResolver: (() => null) as never,
        repoPath: "/repo",
      }),
    ).rejects.toBeInstanceOf(ScoutSourceError);
  });
});
