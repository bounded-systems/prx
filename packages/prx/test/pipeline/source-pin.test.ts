/**
 * prx-adj: the work-unit source pin — the issue/bead authority becomes a
 * content-anchored chain ROOT (`<unit>:source@pinned`).
 *
 * These tests are the contract: a pin round-trips the resolved source; freshness
 * is true for an unchanged source and false once it drifts (the GH issue edited
 * upstream); the best-effort wrapper never throws.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResolvedWorkUnit } from "../../src/pr-state/resolvers/types.ts";
import { consumeArtifact } from "../../src/pipeline/edge.ts";
import {
  pinWorkUnitSource,
  pinWorkUnitSourceBestEffort,
  workUnitSourceEdge,
  workUnitSourceFresh,
} from "../../src/pipeline/source-pin.ts";

const issue = (overrides: Partial<ResolvedWorkUnit> = {}): ResolvedWorkUnit => ({
  id: "prx-0v5",
  title: "task: README is out of date",
  body: "the README drifted from the code",
  state: "open",
  url: "bd://prx-0v5",
  source: "beads",
  ...overrides,
});

let prevRoot: string | undefined;
beforeAll(() => {
  prevRoot = process.env.PRX_CAS_ROOT;
  process.env.PRX_CAS_ROOT = mkdtempSync(join(tmpdir(), "prx-source-pin-"));
});
afterAll(() => {
  if (prevRoot === undefined) delete process.env.PRX_CAS_ROOT;
  else process.env.PRX_CAS_ROOT = prevRoot;
});

describe("work-unit source pin (prx-adj)", () => {
  test("pins the resolved source at <unit>:source@pinned, round-trips by content", async () => {
    const { ref } = await pinWorkUnitSource("prx-0v5", issue());
    expect(ref).toBe("prx-0v5:source@pinned");

    const got = await consumeArtifact(workUnitSourceEdge, "prx-0v5");
    expect(got.value).toEqual({
      id: "prx-0v5",
      title: "task: README is out of date",
      body: "the README drifted from the code",
      state: "open",
      url: "bd://prx-0v5",
      source: "beads",
    });
  });

  test("freshness: a pinned source is fresh; a drifted source is stale", async () => {
    await pinWorkUnitSource("prx-fresh", issue({ id: "prx-fresh" }));

    const same = await workUnitSourceFresh("prx-fresh", issue({ id: "prx-fresh" }));
    expect(same.fresh).toBe(true);
    expect(same.pinnedSha).toBe(same.sourceSha);

    // The upstream issue was edited (title changed) since the pin.
    const drifted = await workUnitSourceFresh(
      "prx-fresh",
      issue({ id: "prx-fresh", title: "task: README — now actually fixed" }),
    );
    expect(drifted.fresh).toBe(false);
    expect(drifted.pinnedSha).not.toBe(drifted.sourceSha);
  });

  test("an unpinned unit reports not fresh (pinnedSha null)", async () => {
    const f = await workUnitSourceFresh("prx-never", issue({ id: "prx-never" }));
    expect(f.pinnedSha).toBeNull();
    expect(f.fresh).toBe(false);
  });

  test("best-effort pin reports success and never throws", async () => {
    const r = await pinWorkUnitSourceBestEffort("prx-be", issue({ id: "prx-be" }));
    expect(r.pinned).toBe(true);
    expect(r.ref).toBe("prx-be:source@pinned");
  });
});
