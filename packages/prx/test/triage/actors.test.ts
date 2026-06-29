// triage per-run XState actors (mirrors dep-research/actors).
//
// This suite is only runnable in isolation because of the companion refactor:
// the parity-chain primitives moved out of the 23k-line `pr-state/cli.ts` into
// their own leaf module, which broke the `actors → prune-merged → cli → prime →
// machine → actors` import cycle (a TDZ on `statusActor`) plus the cli's heavy
// load-time pull. Each real actor's input now also carries an injectable `deps`
// seam forwarded to the delegate, so a wrapper can be driven hermetically.
//
// We prove the seam end-to-end on `statusActor` (driven with empty gh/bd seams
// so it returns without real IO), and cover the `report` stub + TriageStubError.
// The delegate happy paths for the other verbs live in their own suites
// (apply/promote/classifier/…); their wrappers are identical one-liners over the
// same seam.

import { describe, expect, test } from "bun:test";

import { createActor, type AnyActorLogic } from "xstate";

import { reportActor, statusActor, TriageStubError } from "../../src/triage/actors.ts";

// Drive a fromPromise actor and surface its settlement as a promise. The
// `error` observer is required: a standalone (un-parented) actor whose promise
// rejects would otherwise be reported by XState as an unhandled error.
function settle(logic: AnyActorLogic, input: unknown): Promise<unknown> {
  const actor = createActor(logic, { input } as never);
  return new Promise((resolve, reject) => {
    actor.subscribe({
      next: (s) => {
        if (s.status === "done") resolve(s.output);
      },
      error: reject,
    });
    actor.start();
  });
}

describe("statusActor — parses options and forwards the deps seam", () => {
  test("drives the delegate hermetically (empty gh/bd seams) → a status result", async () => {
    const input = {
      repo: "o/r",
      format: "json",
      // The forwarded deps seam (the point of the refactor): empty gh/bd seams
      // keep the delegate off the network and off `bd`. The hermetic set must
      // also stub the read-time freshness gate (refreshSubstrate → a real `gh`
      // fetch), the watermark read (bd), and repo resolution (gh/git) — each is
      // a default that spawns a real subprocess and would otherwise HANG with no
      // service present.
      deps: {
        listOpenIssues: () => [],
        listIssuesByState: () => [],
        execBd: () => ({ exitCode: 0, stdout: "[]", stderr: "", policy: null }),
        refreshSubstrate: () => ({ ok: true as const }),
        readSubstrateWatermark: () => null,
        localRepoForCwd: () => null,
        repoNameWithOwner: () => "o/r",
        cwd: () => "/tmp",
      },
    };
    const result = (await settle(statusActor, input)) as { stdout?: unknown; exitCode?: unknown };
    // The wrapper validated options, forwarded deps, and returned the delegate's
    // actor-shaped result without touching the real gh/bd surfaces.
    expect(result).toBeDefined();
    expect(result).toHaveProperty("exitCode");
  });
});

describe("reportActor (stub)", () => {
  test("validates then rejects with a TriageStubError naming the ticket", async () => {
    let err: unknown;
    try {
      await settle(reportActor, {});
    } catch (e) {
      err = e;
    }
    // Duck-typed (cross-module `instanceof` is unreliable under bun's loader).
    const e = err as { name?: string; verb?: string; ticket?: string; message?: string };
    expect(e.name).toBe("TriageStubError");
    expect(e.verb).toBe("report");
    expect(e.ticket).toBe("GH-1022");
    expect(e.message).toContain("not implemented");
  });
});

describe("TriageStubError", () => {
  test("carries verb + ticket and a descriptive message", () => {
    const e = new TriageStubError("drift-fix", "GH-9999");
    expect(e.name).toBe("TriageStubError");
    expect(e.verb).toBe("drift-fix");
    expect(e.ticket).toBe("GH-9999");
    expect(e.message).toBe("triage drift-fix: not implemented — see GH-9999");
  });
});
