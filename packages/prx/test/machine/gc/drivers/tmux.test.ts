/**
 * gc `tmux` driver (GH-2331 / tywg6) — offline unit + actor round-trip tests.
 *
 * Stubs the injected `TmuxGcOps.reconcile(dryRun)`: dry-run yields `would-apply`
 * deltas, apply yields `applied`/`failed`. No tmux server. Covers drift
 * discovery, the marked-set TOCTOU restriction, per-delta failure + server
 * errors → `failed`, the no-deps no-op, and that `tmux` reconciles under
 * `--apply` WITHOUT a capability token (non-destructive).
 */
import { describe, expect, test } from "bun:test";

import { markFindings } from "../../../../src/machine/gc/capability.ts";
import { createTmuxDriver } from "../../../../src/machine/gc/drivers/tmux.ts";
import type { GcDriverDeps, TmuxGcOps } from "../../../../src/machine/gc/drivers/registry.ts";
import { runInventory, runRun, type GcSweepDeps } from "../../../../src/machine/gc/actor.ts";
import type { TmuxReconcileResult } from "../../../../src/pr-state/tmux-reconcile.ts";

type Delta = { option: string; scope: "global" | "window"; from: string; to: string };
const ref = (d: Delta) => `${d.scope}:${d.option}`;

/** Stub `TmuxGcOps` over a mutable delta set. `failOn`/`errors` shape the apply. */
function tmuxStub(opts: {
  deltas: Delta[];
  failOn?: string[];
  errors?: string[];
}): { ops: TmuxGcOps; applyCount: () => number; setDeltas: (d: Delta[]) => void } {
  let deltas = opts.deltas;
  let applyCount = 0;
  const ops: TmuxGcOps = {
    reconcile: (dryRun) => {
      if (!dryRun) applyCount += 1;
      const applied = deltas.map((d) => {
        const failed = !dryRun && (opts.failOn ?? []).includes(ref(d));
        return {
          ...d,
          command: `set -g ${d.option} ${d.to}`,
          status: dryRun ? "would-apply" : failed ? "failed" : "applied",
          exitCode: failed ? 1 : 0,
          ...(failed ? { stderrTail: "boom" } : {}),
        };
      });
      return {
        socket: "prx",
        serverRunning: true,
        configPath: "/cfg/tmux.conf",
        checked: deltas.length,
        applied,
        unsupported: [],
        inSync: applied.length === 0,
        errors: opts.errors ?? [],
      } as TmuxReconcileResult;
    },
  };
  return { ops, applyCount: () => applyCount, setDeltas: (d) => { deltas = d; } };
}

const A: Delta = { option: "status-style", scope: "global", from: "old", to: "new" };
const B: Delta = { option: "mode-keys", scope: "window", from: "emacs", to: "vi" };

function deps(ops?: TmuxGcOps): GcDriverDeps {
  return {
    repoPath: "/tmp/gc-tmux-test",
    buildParityChain: () => {
      throw new Error("buildParityChain must not be called by the tmux driver");
    },
    ...(ops ? { tmux: ops } : {}),
  } as unknown as GcDriverDeps;
}

describe("createTmuxDriver — mark", () => {
  test("emits a drift finding per would-apply delta", async () => {
    const { ops } = tmuxStub({ deltas: [A, B] });
    const findings = await createTmuxDriver(deps(ops)).mark();
    expect(findings.map((f) => f.ref).sort()).toEqual(["global:status-style", "window:mode-keys"]);
    expect(findings.every((f) => f.component === "tmux" && f.class === "drift")).toBe(true);
    expect(findings.find((f) => f.ref === "global:status-style")?.detail).toBe("old -> new");
  });

  test("in sync (no deltas) → no findings", async () => {
    expect(await createTmuxDriver(deps(tmuxStub({ deltas: [] }).ops)).mark()).toEqual([]);
  });

  test("no-op without injected tmux ops", async () => {
    expect(await createTmuxDriver(deps()).mark()).toEqual([]);
  });
});

describe("createTmuxDriver — sweep", () => {
  test("applies and reclaims the marked deltas", async () => {
    const stub = tmuxStub({ deltas: [A, B] });
    const driver = createTmuxDriver(deps(stub.ops));
    const mark = markFindings("tmux", await driver.mark());
    const { reclaimed, failed } = await driver.sweep(mark, {});
    expect(failed).toBeUndefined();
    expect(reclaimed.map((f) => f.ref).sort()).toEqual(["global:status-style", "window:mode-keys"]);
    expect(stub.applyCount()).toBe(1);
  });

  test("TOCTOU: an option fixed out-of-band since mark is not reclaimed", async () => {
    const stub = tmuxStub({ deltas: [A, B] });
    const driver = createTmuxDriver(deps(stub.ops));
    const mark = markFindings("tmux", await driver.mark()); // marks A, B
    stub.setDeltas([A]); // B reconciled elsewhere between phases
    const { reclaimed } = await driver.sweep(mark, {});
    expect(reclaimed.map((f) => f.ref)).toEqual(["global:status-style"]);
  });

  test("a failed delta → partial (reclaimed + failed)", async () => {
    const stub = tmuxStub({ deltas: [A, B], failOn: ["global:status-style"] });
    const driver = createTmuxDriver(deps(stub.ops));
    const mark = markFindings("tmux", await driver.mark());
    const { reclaimed, failed } = await driver.sweep(mark, {});
    expect(reclaimed.map((f) => f.ref)).toEqual(["window:mode-keys"]);
    expect(failed).toContain("global:status-style");
  });

  test("server-level errors surface as failed", async () => {
    const stub = tmuxStub({ deltas: [A], errors: ["show-option status-style: server down"] });
    const driver = createTmuxDriver(deps(stub.ops));
    const mark = markFindings("tmux", await driver.mark());
    const { reclaimed, failed } = await driver.sweep(mark, {});
    expect(reclaimed.map((f) => f.ref)).toEqual(["global:status-style"]);
    expect(failed).toContain("server down");
  });

  test("no-op without injected tmux ops", async () => {
    expect(await createTmuxDriver(deps()).sweep(markFindings("tmux", []), {})).toEqual({ reclaimed: [] });
  });
});

describe("tmux driver — actor fan-out (non-destructive)", () => {
  test("inventory --component tmux reports drift", async () => {
    const out = await runInventory({ component: "tmux" }, deps(tmuxStub({ deltas: [A] }).ops) as GcSweepDeps);
    expect(out.status).toBe("reclaimable");
    expect(out.by_class.drift).toBe(1);
  });

  test("run --component tmux (dry-run) → would-sweep, not applied", async () => {
    const stub = tmuxStub({ deltas: [A] });
    const out = await runRun({ component: "tmux", apply: false }, deps(stub.ops) as GcSweepDeps);
    expect(out.status).toBe("would-sweep");
    expect(out.reclaimed.map((f) => f.ref)).toEqual(["global:status-style"]);
    expect(stub.applyCount()).toBe(0);
  });

  test("run --component tmux --apply reconciles WITHOUT a capability token", async () => {
    const stub = tmuxStub({ deltas: [A] });
    const out = await runRun({ component: "tmux", apply: true }, deps(stub.ops) as GcSweepDeps);
    expect(out.status).toBe("swept");
    expect(out.reclaimed.map((f) => f.ref)).toEqual(["global:status-style"]);
    expect(out.failed).toEqual([]);
    expect(stub.applyCount()).toBe(1);
  });
});
