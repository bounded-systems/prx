/**
 * gc `hooks` driver (GH-2331 / tywg6) — offline unit + actor round-trip tests.
 *
 * Stubs the injected `HooksGcOps` (`status`/`apply` derive from an in-memory
 * "current hooksPath per repo" map; `apply` mutates it so a re-apply is an
 * idempotent no-op). No git. Exercises: drift discovery, the marked-set
 * restriction (TOCTOU — a repo fixed out-of-band since mark is not re-written
 * or reclaimed), per-repo apply errors → `failed`, the no-deps no-op, and the
 * non-destructive fan-out (`run --apply` sweeps hooks WITHOUT a capability token).
 */
import { describe, expect, test } from "bun:test";

import { markFindings } from "../../../../src/machine/gc/capability.ts";
import { createHooksDriver } from "../../../../src/machine/gc/drivers/hooks.ts";
import type {
  GcDriverDeps,
  HooksGcOps,
} from "../../../../src/machine/gc/drivers/registry.ts";
import { runInventory, runRun } from "../../../../src/machine/gc/actor.ts";
import type { RepoInventory } from "../../../../src/pr-state/repos.ts";

const EXPECTED = "/home/u/.local/share/git-hooks";

/** Build a stub `HooksGcOps` over a mutable `name → current hooksPath` map. */
function hooksStub(opts: {
  current: Record<string, string | null>;
  applyError?: Record<string, string>;
}): {
  ops: HooksGcOps;
  cur: Map<string, string | null>;
  appliedBatches: string[][];
} {
  const cur = new Map<string, string | null>(Object.entries(opts.current));
  const appliedBatches: string[][] = [];
  const inventory = {
    repos: [...cur.keys()].map((name) => ({ name, commonDir: `/repos/${name}/.git` })),
    bareRoot: "/repos",
    configPath: "/repos/config.json",
    indexPath: "/repos/index.json",
  } as unknown as RepoInventory;

  const ops: HooksGcOps = {
    resolve: () => ({ inventory, expectedPath: EXPECTED }),
    status: (inv, expected) => ({
      hooksPath: expected,
      repos: inv.repos.map((r) => {
        const c = cur.get(r.name) ?? null;
        return { name: r.name, commonDir: r.commonDir, currentHooksPath: c, matches: c === expected };
      }),
    }),
    apply: (inv, expected) => {
      appliedBatches.push(inv.repos.map((r) => r.name));
      return {
        hooksPath: expected,
        repos: inv.repos.map((r) => {
          const prev = cur.get(r.name) ?? null;
          const err = opts.applyError?.[r.name];
          if (err) {
            return { name: r.name, commonDir: r.commonDir, previousHooksPath: prev, newHooksPath: expected, changed: false, error: err };
          }
          cur.set(r.name, expected); // the write
          return { name: r.name, commonDir: r.commonDir, previousHooksPath: prev, newHooksPath: expected, changed: prev !== expected };
        }),
      };
    },
  };
  return { ops, cur, appliedBatches };
}

/** Driver deps with a `buildParityChain` that must never fire on the hooks path. */
function deps(ops?: HooksGcOps): GcDriverDeps {
  return {
    repoPath: "/tmp/gc-hooks-test",
    buildParityChain: () => {
      throw new Error("buildParityChain must not be called by the hooks driver");
    },
    ...(ops ? { hooks: ops } : {}),
  } as unknown as GcDriverDeps;
}

describe("createHooksDriver — mark", () => {
  test("emits a drift finding per non-matching repo, skips matches", async () => {
    const { ops } = hooksStub({ current: { a: "/wrong", b: null, c: EXPECTED } });
    const findings = await createHooksDriver(deps(ops)).mark();
    expect(findings.map((f) => f.ref).sort()).toEqual(["a", "b"]);
    expect(findings.every((f) => f.component === "hooks" && f.class === "drift")).toBe(true);
    expect(findings.find((f) => f.ref === "a")?.detail).toBe(`/wrong -> ${EXPECTED}`);
    expect(findings.find((f) => f.ref === "b")?.detail).toBe(`<unset> -> ${EXPECTED}`);
  });

  test("clean inventory → no findings", async () => {
    const { ops } = hooksStub({ current: { c: EXPECTED } });
    expect(await createHooksDriver(deps(ops)).mark()).toEqual([]);
  });

  test("no-op without injected hooks ops", async () => {
    expect(await createHooksDriver(deps()).mark()).toEqual([]);
  });
});

describe("createHooksDriver — sweep", () => {
  test("applies the marked-and-still-drifted repos and reclaims the changed ones", async () => {
    const { ops, appliedBatches } = hooksStub({ current: { a: "/wrong", b: null, c: EXPECTED } });
    const driver = createHooksDriver(deps(ops));
    const mark = markFindings("hooks", await driver.mark());
    const { reclaimed, failed } = await driver.sweep(mark, {});
    expect(failed).toBeUndefined();
    expect(reclaimed.map((f) => f.ref).sort()).toEqual(["a", "b"]);
    // c (already matching) is never even passed to apply.
    expect(appliedBatches).toEqual([["a", "b"]]);
  });

  test("TOCTOU: a repo fixed out-of-band since mark is neither re-written nor reclaimed", async () => {
    const { ops, cur, appliedBatches } = hooksStub({ current: { a: "/wrong", b: "/wrong" } });
    const driver = createHooksDriver(deps(ops));
    const mark = markFindings("hooks", await driver.mark()); // marks [a, b]
    cur.set("b", EXPECTED); // b reconciled by something else between phases
    const { reclaimed } = await driver.sweep(mark, {});
    expect(reclaimed.map((f) => f.ref)).toEqual(["a"]);
    expect(appliedBatches).toEqual([["a"]]); // b never written
  });

  test("per-repo apply error surfaces as failed; the rest still reclaim", async () => {
    const { ops } = hooksStub({ current: { a: "/wrong", b: "/wrong" }, applyError: { a: "locked" } });
    const driver = createHooksDriver(deps(ops));
    const mark = markFindings("hooks", await driver.mark());
    const { reclaimed, failed } = await driver.sweep(mark, {});
    expect(reclaimed.map((f) => f.ref)).toEqual(["b"]);
    expect(failed).toContain("a: locked");
  });

  test("empty mark → no apply, nothing reclaimed", async () => {
    const { ops, appliedBatches } = hooksStub({ current: { c: EXPECTED } });
    const driver = createHooksDriver(deps(ops));
    const out = await driver.sweep(markFindings("hooks", []), {});
    expect(out).toEqual({ reclaimed: [] });
    expect(appliedBatches).toEqual([]);
  });

  test("no-op without injected hooks ops", async () => {
    expect(await createHooksDriver(deps()).sweep(markFindings("hooks", []), {})).toEqual({ reclaimed: [] });
  });
});

describe("hooks driver — actor fan-out", () => {
  test("inventory --component hooks reports drift", async () => {
    const { ops } = hooksStub({ current: { a: "/wrong", b: EXPECTED } });
    const out = await runInventory({ component: "hooks" }, deps(ops));
    expect(out.status).toBe("reclaimable");
    expect(out.findings.map((f) => f.ref)).toEqual(["a"]);
    expect(out.by_class.drift).toBe(1);
  });

  test("run --component hooks (dry-run) reports would-sweep without applying", async () => {
    const { ops, appliedBatches } = hooksStub({ current: { a: "/wrong" } });
    const out = await runRun({ component: "hooks", apply: false }, deps(ops));
    expect(out.status).toBe("would-sweep");
    expect(out.dry_run).toBe(true);
    expect(out.reclaimed.map((f) => f.ref)).toEqual(["a"]);
    expect(appliedBatches).toEqual([]); // dry-run never sweeps
  });

  test("run --component hooks --apply sweeps WITHOUT a capability token (non-destructive)", async () => {
    const { ops, appliedBatches } = hooksStub({ current: { a: "/wrong" } });
    const out = await runRun({ component: "hooks", apply: true }, deps(ops));
    expect(out.status).toBe("swept");
    expect(out.dry_run).toBe(false);
    expect(out.reclaimed.map((f) => f.ref)).toEqual(["a"]);
    expect(out.failed).toEqual([]);
    expect(appliedBatches).toEqual([["a"]]);
  });
});
