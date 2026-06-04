/**
 * prx-4fa (epic prx-997) — intake→triage edge.
 *
 * A `uow` is pinned from its impure home (bd/gh) into the CAS via the FOD pin,
 * consumed by triage as an immutable snapshot, with content-hash freshness.
 * Uses an INJECTED fake reader — no real bd/gh — so the edge is CI-testable.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type RawUow,
  type UowReader,
  consumeUow,
  intakeToTriage,
  normalizeUow,
  pinUow,
  uowFresh,
} from "../../src/pipeline/edges/intake-triage.ts";

let prevRoot: string | undefined;
beforeAll(() => {
  prevRoot = process.env.PRX_CAS_ROOT;
  process.env.PRX_CAS_ROOT = mkdtempSync(join(tmpdir(), "prx-it-cas-"));
});
afterAll(() => {
  if (prevRoot === undefined) delete process.env.PRX_CAS_ROOT;
  else process.env.PRX_CAS_ROOT = prevRoot;
});

/** A fake bd/gh whose contents we control — the impure source. */
function fakeReader(store: Record<string, RawUow>): UowReader {
  return (unit) => {
    const row = store[unit];
    if (!row) throw new Error(`fake: no record for ${unit}`);
    return row;
  };
}

describe("intake→triage edge (prx-4fa)", () => {
  test("declares uow/git ownership intake→triage", () => {
    expect(intakeToTriage.kind).toBe("uow");
    expect(intakeToTriage.persistence).toBe("git");
    expect(intakeToTriage.source).toBe("intake");
    expect(intakeToTriage.target).toBe("triage");
  });

  test("normalizeUow validates and rejects an unknown status", () => {
    expect(normalizeUow({ id: "GH-1", title: "t", status: "open" }).status).toBe("open");
    expect(() => normalizeUow({ id: "GH-1", title: "t", status: "frozen" })).toThrow();
  });

  test("intake pins a uow from its impure home; triage consumes the snapshot", async () => {
    const read = fakeReader({
      "GH-1900": { id: "GH-1900", title: "stale board column", status: "open" },
    });
    const { ref } = await pinUow("GH-1900", read);
    expect(ref).toBe("GH-1900:uow@snapshot");

    const got = await consumeUow("GH-1900");
    expect(got.value).toEqual({ id: "GH-1900", title: "stale board column", status: "open" });
  });

  test("pinUow propagates reader errors for unknown units", async () => {
    const read = fakeReader({
      "GH-1900": { id: "GH-1900", title: "stale board column", status: "open" },
    });

    await expect(pinUow("GH-UNKNOWN", read)).rejects.toThrow(
      "fake: no record for GH-UNKNOWN",
    );
  });

  test("uowFresh: fresh after pin, stale once the live issue/bead drifts", async () => {
    const store: Record<string, RawUow> = {
      "GH-2000": { id: "GH-2000", title: "v1", status: "open" },
    };
    const read = fakeReader(store);
    await pinUow("GH-2000", read);
    expect((await uowFresh("GH-2000", read)).fresh).toBe(true);

    // The bead advanced upstream (open → in_progress).
    store["GH-2000"] = { id: "GH-2000", title: "v1", status: "in_progress" };
    const f = await uowFresh("GH-2000", read);
    expect(f.fresh).toBe(false);
    expect(f.pinnedSha).not.toBe(f.sourceSha);
  });
});
