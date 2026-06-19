// sync/backfill — the domain backfill orchestrator. Fully injectable
// (adapter / loadAllBeads / refreshBudget / runIntakeMirror / repoNameWithOwner
// / now / audit), so every record outcome + early-exit is covered without a
// live gh/bd. Uses domain "gh" with an injected adapter (no real gh).

import { describe, expect, test } from "bun:test";

import {
  runBackfill,
  type RunBackfillDeps,
  type RunBackfillOptions,
} from "../../src/sync/backfill.ts";

type Ref = { externalId: string; surfaceId: string };

const adapterWith = (over: {
  refs?: Ref[];
  resolve?: (ext: string) => string | null;
  enumerateThrows?: boolean;
}): NonNullable<RunBackfillDeps["adapter"]> =>
  ({
    surfaceIdToExternalId: (id: string) => id,
    enumerate: async () => {
      if (over.enumerateThrows) throw new Error("enumerate boom");
      return over.refs ?? [];
    },
    resolveFromBeads: over.resolve ?? (() => null),
  }) as never;

// runIntakeMirror seam: control exit code + the (raw) line(s) it logs.
const mirror = (
  exit: number,
  render?: object,
  rawLine?: string,
): NonNullable<RunBackfillDeps["runIntakeMirror"]> =>
  ((_opts: unknown, out: { log: (l: string) => void }) => {
    if (render) out.log(JSON.stringify(render));
    if (rawLine !== undefined) out.log(rawLine);
    return exit;
  }) as never;

const baseDeps = (over: Partial<RunBackfillDeps> = {}): RunBackfillDeps => ({
  now: () => new Date("2026-06-07T00:00:00Z"),
  cwd: () => "/repo",
  repoNameWithOwner: () => "owner/repo",
  loadAllBeads: () => [],
  refreshBudget: () => null, // graphqlRemaining(null) → null → never paused
  appendAuditRow: () => {},
  getAuditRuntimeContext: () => ({ verb: null, actor: "test", ghTruthReason: null }) as never,
  ...over,
});

const sink = () => {
  const logs: string[] = [];
  const errs: string[] = [];
  return {
    out: { log: (l: string) => logs.push(l), error: (e: string) => errs.push(e) },
    logs,
    errs,
  };
};

const opts = (over: Partial<RunBackfillOptions> = {}): RunBackfillOptions => ({
  domain: "gh",
  from: 1,
  to: 1,
  dryRun: false,
  format: "plain",
  ...over,
});

describe("runBackfill early-exit / error paths", () => {
  test("unregistered domain → failure (exit 1)", async () => {
    const s = sink();
    const r = await runBackfill(opts({ domain: "zzz-not-a-domain" }), s.out, baseDeps());
    expect(r.exitCode).toBe(1);
    expect(s.errs[0]).toMatch(/no registered adapter/);
  });

  test("repoNameWithOwner throws → failure", async () => {
    const s = sink();
    const r = await runBackfill(
      opts({ repo: "" }),
      s.out,
      baseDeps({
        repoNameWithOwner: () => {
          throw new Error("not a repo");
        },
        adapter: adapterWith({}),
      }),
    );
    expect(r.exitCode).toBe(1);
    expect(s.errs[0]).toMatch(/could not resolve OWNER\/REPO: not a repo/);
  });

  test("empty resolved repo → failure", async () => {
    const s = sink();
    const r = await runBackfill(
      opts({ repo: "" }),
      s.out,
      baseDeps({
        repoNameWithOwner: () => "   ",
        adapter: adapterWith({}),
      }),
    );
    expect(r.exitCode).toBe(1);
    expect(s.errs[0]).toMatch(/could not resolve OWNER\/REPO from cwd/);
  });

  test("loadAllBeads throws → failure", async () => {
    const s = sink();
    const r = await runBackfill(
      opts(),
      s.out,
      baseDeps({
        loadAllBeads: () => {
          throw new Error("bd down");
        },
        adapter: adapterWith({}),
      }),
    );
    expect(r.exitCode).toBe(1);
    expect(s.errs[0]).toMatch(/bd down/);
  });

  test("enumerate throws → failure", async () => {
    const s = sink();
    const r = await runBackfill(
      opts(),
      s.out,
      baseDeps({ adapter: adapterWith({ enumerateThrows: true }) }),
    );
    expect(r.exitCode).toBe(1);
    expect(s.errs[0]).toMatch(/enumerate boom/);
  });

  test("gh domain with no injected adapter constructs the real GhDomainAdapter", async () => {
    // No deps.adapter + domain "gh" → exercises the production GhDomainAdapter
    // construction; enumerate then hits real gh against a bogus repo (404 /
    // unauth) and the failure is caught — we only assert it returns a result.
    const s = sink();
    const r = await runBackfill(
      opts({ repo: "prx-nonexistent-xyz/nope" }),
      s.out,
      baseDeps({ refreshBudget: () => null }),
    );
    expect(typeof r.exitCode).toBe("number");
  });

  test("graphql budget below threshold at entry → paused (exit 0)", async () => {
    const s = sink();
    const r = await runBackfill(
      opts(),
      s.out,
      baseDeps({
        adapter: adapterWith({ refs: [{ externalId: "1", surfaceId: "GH-1" }] }),
        refreshBudget: () =>
          [{ bucket: "graphql", remaining: 5, limit: 5000, resetAt: 0, fetchedAt: 0 }] as never,
      }),
    );
    expect(r.exitCode).toBe(0);
    expect(r.summary.budgetPaused).toBe(true);
    expect(s.logs[0]).toMatch(/paused: GraphQL budget 5/);
  });
});

describe("runBackfill record outcomes (plain format)", () => {
  const refs = [{ externalId: "1", surfaceId: "GH-1" }];

  test("already-resolved record → skipped", async () => {
    const s = sink();
    const r = await runBackfill(
      opts(),
      s.out,
      baseDeps({
        adapter: adapterWith({ refs, resolve: () => "bd-aaa" }),
      }),
    );
    expect(r.summary.skipped).toBe(1);
    expect(s.logs[0]).toMatch(/skip GH-1 → bd-aaa/);
  });

  test("mirror failure → failed record", async () => {
    const s = sink();
    const r = await runBackfill(
      opts(),
      s.out,
      baseDeps({
        adapter: adapterWith({ refs }),
        runIntakeMirror: mirror(1),
      }),
    );
    expect(r.summary.failed).toBe(1);
    expect(s.logs[0]).toMatch(/FAIL GH-1/);
  });

  test("mirror returns an existing bd id (race) → skipped", async () => {
    const s = sink();
    const r = await runBackfill(
      opts(),
      s.out,
      baseDeps({
        adapter: adapterWith({ refs }),
        runIntakeMirror: mirror(0, { existingBdId: "bd-race" }),
      }),
    );
    expect(r.summary.skipped).toBe(1);
    expect(s.logs[0]).toMatch(/skip GH-1 → bd-race/);
  });

  test("mirror creates a new record → mirrored", async () => {
    const s = sink();
    const r = await runBackfill(
      opts(),
      s.out,
      baseDeps({
        adapter: adapterWith({ refs }),
        runIntakeMirror: mirror(0, { createdBdId: "bd-new" }),
      }),
    );
    expect(r.summary.mirrored).toBe(1);
    expect(s.logs[0]).toMatch(/mirror GH-1 → bd-new/);
  });

  test("budget falls below threshold mid-loop → deferred, exit 2", async () => {
    let call = 0;
    const s = sink();
    const r = await runBackfill(
      opts({ to: 2 }),
      s.out,
      baseDeps({
        adapter: adapterWith({
          refs: [
            { externalId: "1", surfaceId: "GH-1" },
            { externalId: "2", surfaceId: "GH-2" },
          ],
        }),
        runIntakeMirror: mirror(0, { createdBdId: "bd-1" }),
        // entry budget ok (null); the per-record recheck (i>0) trips the cutoff.
        refreshBudget: () =>
          ++call === 1
            ? null
            : ([
                { bucket: "graphql", remaining: 1, limit: 5000, resetAt: 0, fetchedAt: 0 },
              ] as never),
      }),
    );
    expect(r.exitCode).toBe(2);
    expect(r.summary.deferred).toBe(1);
    expect(s.errs.join("\n")).toMatch(/budget/);
  });

  test("mirror create with no JSON render → mirrored (parse returns null)", async () => {
    const s = sink();
    const r = await runBackfill(
      opts(),
      s.out,
      baseDeps({
        adapter: adapterWith({ refs }),
        runIntakeMirror: mirror(0), // logs nothing → parseMirrorRender → null
      }),
    );
    expect(r.summary.mirrored).toBe(1);
    expect(s.logs[0]).toMatch(/mirror GH-1/);
  });

  test("mirror render with a malformed JSON line is tolerated", async () => {
    const s = sink();
    const r = await runBackfill(
      opts(),
      s.out,
      baseDeps({
        adapter: adapterWith({ refs }),
        runIntakeMirror: mirror(0, undefined, "{ not valid json"), // hits the JSON.parse catch
      }),
    );
    expect(r.summary.mirrored).toBe(1);
  });

  test("json format round-trips the summary + records", async () => {
    const s = sink();
    await runBackfill(
      opts({ format: "json" }),
      s.out,
      baseDeps({
        adapter: adapterWith({ refs, resolve: () => "bd-x" }),
      }),
    );
    expect(JSON.parse(s.logs[0]!).records[0].action).toBe("skipped");
  });
});
