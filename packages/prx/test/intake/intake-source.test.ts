/**
 * GH-232: `prx intake source <UoW>` — the intake role owns the chain ROOT.
 * It resolves the unit's source (GH/bd/notion, uniformly) and pins it as
 * `<unit>:source@pinned`, so the sandboxed planner CONSUMES the real issue
 * instead of fabricating. Runnable by a human operator or an intake agent.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResolvedWorkUnit, WorkUnitResolver } from "../../src/pr-state/resolvers/types.ts";
import { consumeArtifact } from "../../src/pipeline/edge.ts";
import { workUnitSourceEdge } from "../../src/pipeline/source-pin.ts";
import { runIntakeSource, IntakeSourceError } from "../../src/intake/intake-source.ts";

const resolved = (overrides: Partial<ResolvedWorkUnit> = {}): ResolvedWorkUnit => ({
  id: "GH-232",
  title: "Promote source-pin to an intake actor before plan",
  body: "source@pinned should be owned by intake, not the plan gate.",
  state: "open",
  url: "https://github.com/owner/repo/issues/232",
  source: "github",
  ...overrides,
});

const fakeResolver = (unit: ResolvedWorkUnit): WorkUnitResolver => ({
  name: unit.source,
  fetch: async () => unit,
});

const sink = () => {
  const lines: string[] = [];
  return { out: { log: (l: string) => lines.push(l), error: (l: string) => lines.push(l) }, lines };
};

let prevRoot: string | undefined;
beforeAll(() => {
  prevRoot = process.env.PRX_CAS_ROOT;
  process.env.PRX_CAS_ROOT = mkdtempSync(join(tmpdir(), "gh-232-intake-source-"));
});
afterAll(() => {
  if (prevRoot === undefined) delete process.env.PRX_CAS_ROOT;
  else process.env.PRX_CAS_ROOT = prevRoot;
});

describe("prx intake source (GH-232)", () => {
  test("resolves the unit and pins <unit>:source@pinned (consumable by the planner)", async () => {
    const { out } = sink();
    const unit = resolved({ id: "GH-232" });
    const code = await runIntakeSource(
      { id: "GH-232", format: "plain" },
      out,
      {
        loadIdentity: (() => ({})) as never,
        buildResolver: (() => fakeResolver(unit)) as never,
        repoPath: "/repo",
      },
    );
    expect(code).toBe(0);

    const pinned = await consumeArtifact(workUnitSourceEdge, "GH-232");
    expect(pinned.missing).toBeUndefined();
    expect(pinned.value?.source).toBe("github");
    expect(pinned.value?.title).toBe("Promote source-pin to an intake actor before plan");
    expect(pinned.value?.body).toBe("source@pinned should be owned by intake, not the plan gate.");
  });

  test("json format reports the pinned ref + resolved source", async () => {
    const { out, lines } = sink();
    const unit = resolved({ id: "GH-901", source: "beads", title: "bd unit", url: "bd://GH-901" });
    const code = await runIntakeSource(
      { id: "GH-901", format: "json" },
      out,
      {
        loadIdentity: (() => ({})) as never,
        buildResolver: (() => fakeResolver(unit)) as never,
        repoPath: "/repo",
      },
    );
    expect(code).toBe(0);
    const payload = JSON.parse(lines[0]!);
    expect(payload.unit).toBe("GH-901");
    expect(payload.source).toBe("beads");
    expect(typeof payload.ref).toBe("string");
    expect(payload.ref.length).toBeGreaterThan(0);
  });

  test("throws when no resolver is configured for the id", async () => {
    const { out } = sink();
    await expect(
      runIntakeSource(
        { id: "GH-999", format: "plain" },
        out,
        {
          loadIdentity: (() => ({})) as never,
          buildResolver: (() => null) as never,
          repoPath: "/repo",
        },
      ),
    ).rejects.toBeInstanceOf(IntakeSourceError);
  });
});
