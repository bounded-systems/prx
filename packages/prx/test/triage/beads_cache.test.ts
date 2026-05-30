// GH-1595 — per-invocation memoization layer over `loadAllBeads`. Three
// guarantees we pin here: first `load()` runs the loader; subsequent calls
// reuse it; `invalidate()` forces the next `load()` to re-run the loader.
// Independent caches don't share state.

import { describe, expect, test } from "bun:test";

import { createBeadsCache } from "../../src/triage/beads_cache.ts";
import type { BeadsRecord } from "../../src/triage/triage.ts";

function bead(id: string): BeadsRecord {
  return {
    id,
    title: id,
    description: "",
    status: "open",
    priority: null,
    issueType: "task",
    externalRef: null,
    externalRefs: {},
    metadata: null,
    externalIssueNumber: null,
    sourceSystem: null,
  };
}

describe("createBeadsCache", () => {
  test("memoizes the canonical read across N load() calls", () => {
    let calls = 0;
    const cache = createBeadsCache({
      loadAllBeads: () => {
        calls += 1;
        return [bead("ai-home-a"), bead("ai-home-b")];
      },
    });

    const first = cache.load();
    const second = cache.load();
    const third = cache.load();

    expect(calls).toBe(1);
    expect(first).toEqual([bead("ai-home-a"), bead("ai-home-b")]);
    // Stable identity — repeated callers see the same array reference, so
    // mutating one snapshot would surprise other readers. Production sites
    // never mutate the array; this assertion makes that contract visible.
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  test("invalidate() forces the next load() to re-run the loader", () => {
    let calls = 0;
    const records: BeadsRecord[][] = [
      [bead("ai-home-a")],
      [bead("ai-home-a"), bead("ai-home-b")],
    ];
    const cache = createBeadsCache({
      loadAllBeads: () => {
        const snapshot = records[calls] ?? records[records.length - 1]!;
        calls += 1;
        return snapshot;
      },
    });

    expect(cache.load()).toEqual([bead("ai-home-a")]);
    cache.invalidate();
    expect(cache.load()).toEqual([bead("ai-home-a"), bead("ai-home-b")]);
    expect(calls).toBe(2);
  });

  test("independent caches do not share state", () => {
    let aCalls = 0;
    let bCalls = 0;
    const cacheA = createBeadsCache({
      loadAllBeads: () => {
        aCalls += 1;
        return [bead("a")];
      },
    });
    const cacheB = createBeadsCache({
      loadAllBeads: () => {
        bCalls += 1;
        return [bead("b")];
      },
    });

    cacheA.load();
    cacheA.load();
    cacheB.load();

    expect(aCalls).toBe(1);
    expect(bCalls).toBe(1);
    expect(cacheA.load()[0]?.id).toBe("a");
    expect(cacheB.load()[0]?.id).toBe("b");
  });
});
