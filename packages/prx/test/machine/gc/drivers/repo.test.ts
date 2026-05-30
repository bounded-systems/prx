/**
 * gc `repo` driver (GH-2331 / tywg6) — offline unit + actor round-trip tests.
 *
 * Stubs the injected `RepoGcOps.run(apply)`: dry-run yields `would-sweep`
 * entries, apply yields `swept`/`refused`. No filesystem. Covers orphan
 * discovery (only would-sweep entries become findings), the marked-set TOCTOU
 * restriction, a refused-at-apply entry → `failed`, the no-deps no-op, and that
 * `repo` is gated as a destructive component (`rm -rf`).
 */
import { describe, expect, test } from "bun:test";

import { markFindings } from "../../../../src/machine/gc/capability.ts";
import { createRepoDriver } from "../../../../src/machine/gc/drivers/repo.ts";
import type { GcDriverDeps, RepoGcOps } from "../../../../src/machine/gc/drivers/registry.ts";
import { runInventory, runRun, type GcSweepDeps } from "../../../../src/machine/gc/actor.ts";
import type { RepoGcAction, RepoGcReport } from "../../../../src/pr-state/repo_gc.ts";

type EntrySpec = {
  slug: string;
  orphanPath: string | null;
  orphanBytes?: number;
  dry: RepoGcAction;
  apply?: RepoGcAction; // defaults to `dry`
  refusalReason?: "not-migrated" | "server-unreachable" | "db-empty";
};

/** Stub `RepoGcOps` over a mutable entry set. */
function repoStub(init: EntrySpec[]): {
  ops: RepoGcOps;
  applies: () => boolean[];
  setEntries: (e: EntrySpec[]) => void;
} {
  let entries = init;
  const applies: boolean[] = [];
  const ops: RepoGcOps = {
    run: (apply) => {
      applies.push(apply);
      const rows = entries.map((e) => ({
        slug: e.slug,
        commonDir: `/repos/${e.slug}.git`,
        workspacePath: `/wt/${e.slug}`,
        classification: "shared-server",
        orphanPath: e.orphanPath,
        orphanBytes: e.orphanBytes ?? null,
        action: apply ? (e.apply ?? e.dry) : e.dry,
        ...(e.refusalReason ? { refusalReason: e.refusalReason } : {}),
      }));
      return {
        apply,
        scanned: rows.length,
        orphansFound: rows.filter((r) => r.orphanPath).length,
        swept: rows.filter((r) => r.action === "swept").length,
        refused: rows.filter((r) => r.action === "refused").length,
        cleanedBytes: 0,
        durationMs: 0,
        entries: rows,
      } as unknown as RepoGcReport;
    },
  };
  return { ops, applies: () => applies, setEntries: (e) => { entries = e; } };
}

const orphanA: EntrySpec = { slug: "repo-a", orphanPath: "/wt/repo-a/embeddeddolt/db", orphanBytes: 4096, dry: "would-sweep", apply: "swept" };
const orphanD: EntrySpec = { slug: "repo-d", orphanPath: "/wt/repo-d/embeddeddolt/db", orphanBytes: 512, dry: "would-sweep", apply: "swept" };

function deps(ops?: RepoGcOps): GcDriverDeps {
  return {
    repoPath: "/tmp/gc-repo-test",
    buildParityChain: () => {
      throw new Error("buildParityChain must not be called by the repo driver");
    },
    ...(ops ? { repo: ops } : {}),
  } as unknown as GcDriverDeps;
}

describe("createRepoDriver — mark", () => {
  test("emits an orphan finding per would-sweep entry; skips refused + nothing-to-clean", async () => {
    const { ops } = repoStub([
      orphanA,
      { slug: "blocked-b", orphanPath: "/wt/blocked-b/embeddeddolt/db", dry: "refused", refusalReason: "db-empty" },
      { slug: "clean-c", orphanPath: null, dry: "nothing-to-clean" },
    ]);
    const findings = await createRepoDriver(deps(ops)).mark();
    expect(findings.map((f) => f.ref)).toEqual(["/wt/repo-a/embeddeddolt/db"]);
    expect(findings[0]).toMatchObject({ component: "repo", class: "orphan", reclaim_bytes: 4096 });
  });

  test("nothing reclaimable → no findings", async () => {
    const { ops } = repoStub([{ slug: "c", orphanPath: null, dry: "nothing-to-clean" }]);
    expect(await createRepoDriver(deps(ops)).mark()).toEqual([]);
  });

  test("no-op without injected repo ops", async () => {
    expect(await createRepoDriver(deps()).mark()).toEqual([]);
  });
});

describe("createRepoDriver — sweep", () => {
  test("rm's and reclaims the marked orphans", async () => {
    const stub = repoStub([orphanA, orphanD]);
    const driver = createRepoDriver(deps(stub.ops));
    const mark = markFindings("repo", await driver.mark());
    const { reclaimed, failed } = await driver.sweep(mark, {});
    expect(failed).toBeUndefined();
    expect(reclaimed.map((f) => f.ref).sort()).toEqual([
      "/wt/repo-a/embeddeddolt/db",
      "/wt/repo-d/embeddeddolt/db",
    ]);
    expect(stub.applies()).toEqual([false, false, true]); // mark, sweep-re-derive, sweep-apply
  });

  test("TOCTOU: an orphan gone from the live plan since mark is not reclaimed", async () => {
    const stub = repoStub([orphanA, orphanD]);
    const driver = createRepoDriver(deps(stub.ops));
    const mark = markFindings("repo", await driver.mark()); // marks A, D
    stub.setEntries([orphanA]); // D got cleaned/un-orphaned between phases
    const { reclaimed } = await driver.sweep(mark, {});
    expect(reclaimed.map((f) => f.ref)).toEqual(["/wt/repo-a/embeddeddolt/db"]);
  });

  test("an orphan refused at apply (precondition regressed) → failed", async () => {
    const stub = repoStub([
      orphanA,
      { slug: "repo-d", orphanPath: "/wt/repo-d/embeddeddolt/db", orphanBytes: 512, dry: "would-sweep", apply: "refused", refusalReason: "server-unreachable" },
    ]);
    const driver = createRepoDriver(deps(stub.ops));
    const mark = markFindings("repo", await driver.mark());
    const { reclaimed, failed } = await driver.sweep(mark, {});
    expect(reclaimed.map((f) => f.ref)).toEqual(["/wt/repo-a/embeddeddolt/db"]);
    expect(failed).toContain("/wt/repo-d/embeddeddolt/db");
    expect(failed).toContain("server-unreachable");
  });

  test("no-op without injected repo ops", async () => {
    expect(await createRepoDriver(deps()).sweep(markFindings("repo", []), {})).toEqual({ reclaimed: [] });
  });
});

describe("repo driver — actor fan-out (destructive gate)", () => {
  test("inventory --component repo reports the orphans", async () => {
    const out = await runInventory({ component: "repo" }, deps(repoStub([orphanA]).ops) as GcSweepDeps);
    expect(out.status).toBe("reclaimable");
    expect(out.by_class.orphan).toBe(1);
  });

  test("run --component repo --apply WITHOUT a token → capability-required, not applied", async () => {
    const stub = repoStub([orphanA]);
    const out = await runRun({ component: "repo", apply: true }, deps(stub.ops) as GcSweepDeps);
    expect(out.status).toBe("capability-required");
    expect(out.reclaimed).toEqual([]);
    // mark ran (dry), but no apply (run(true)) — gated before sweep
    expect(stub.applies()).toEqual([false]);
  });

  test("run --component repo --apply WITH gc:delete → swept", async () => {
    const stub = repoStub([orphanA]);
    const out = await runRun(
      { component: "repo", apply: true, capability: "gc:delete" },
      deps(stub.ops) as GcSweepDeps,
    );
    expect(out.status).toBe("swept");
    expect(out.reclaimed.map((f) => f.ref)).toEqual(["/wt/repo-a/embeddeddolt/db"]);
    expect(stub.applies()).toContain(true);
  });
});
