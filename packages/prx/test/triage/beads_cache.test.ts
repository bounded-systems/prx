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

describe("createBeadsCache — UoW coherence + generation (GH-296)", () => {
  test("upsert patches one record by id, not a full re-list", () => {
    let calls = 0;
    const cache = createBeadsCache({ loadAllBeads: () => (calls++, [bead("a"), bead("b")]) });
    cache.load();
    cache.upsert({ ...bead("b"), title: "b-updated" });
    cache.upsert(bead("c")); // insert
    const out = cache.load();
    expect(calls).toBe(1); // no re-list
    expect(out.find((r) => r.id === "b")?.title).toBe("b-updated");
    expect(out.map((r) => r.id).sort()).toEqual(["a", "b", "c"]);
  });

  test("remove drops one record by id without re-listing", () => {
    let calls = 0;
    const cache = createBeadsCache({ loadAllBeads: () => (calls++, [bead("a"), bead("b")]) });
    cache.load();
    cache.remove("a");
    expect(cache.load().map((r) => r.id)).toEqual(["b"]);
    expect(calls).toBe(1);
  });

  test("upsert/remove are no-ops when nothing is cached", () => {
    let calls = 0;
    const cache = createBeadsCache({ loadAllBeads: () => (calls++, [bead("a")]) });
    cache.upsert(bead("z")); // before any load
    cache.remove("a");
    expect(cache.load().map((r) => r.id)).toEqual(["a"]); // load is authoritative
    expect(calls).toBe(1);
  });

  test("generation: stable HEAD serves cached; moved HEAD re-fetches", () => {
    let calls = 0;
    let head = "h1";
    const cache = createBeadsCache({
      loadAllBeads: () => (calls++, [bead(`gen-${calls}`)]),
      generation: () => head,
    });
    cache.load();
    cache.load(); // same HEAD → cached
    expect(calls).toBe(1);
    head = "h2"; // HEAD moved (e.g. a write or a reconcile pulled commits)
    cache.load();
    expect(calls).toBe(2);
  });
});

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
