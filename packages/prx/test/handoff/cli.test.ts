// GH-1397 — the `prx handoff` CLI verbs (enqueue/status/drain/replay). Each now
// takes an injectable `deps` seam (store/drain/audit); these drive their
// branches against an in-memory bd fake — no live bd substrate, no audit IO.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runHandoffDrain,
  runHandoffEnqueue,
  runHandoffReplay,
  runHandoffStatus,
  type HandoffCliDeps,
  type HandoffCliOutput,
} from "../../src/handoff/cli.ts";
import type { HandoffStoreDeps } from "../../src/handoff/store.ts";
import type { BdExecOptions, BdExecResult } from "@bounded-systems/bd";

// ── fakes ───────────────────────────────────────────────────────────────────

function sink() {
  const logs: string[] = [];
  const errors: string[] = [];
  const out: HandoffCliOutput = { log: (l) => logs.push(l), error: (e) => errors.push(e) };
  return { out, logs, errors };
}

// An in-memory bd: `remember` stores a row by --key, `memories` returns rows
// under a prefix. Backing both with one map makes the dedup/read paths real.
function makeFakeBd(rows = new Map<string, string>()): HandoffStoreDeps["execBd"] {
  return (opts: BdExecOptions): BdExecResult => {
    if (opts.subcommand === "remember") {
      const body = opts.args[0] as string;
      const keyIdx = opts.args.indexOf("--key");
      rows.set(opts.args[keyIdx + 1] as string, body);
      return { exitCode: 0, stdout: "{}", stderr: "", policy: null };
    }
    if (opts.subcommand === "memories") {
      const prefix = opts.args[0] as string;
      const out: Array<{ key: string; body: string }> = [];
      for (const [k, v] of rows) if (k.startsWith(prefix)) out.push({ key: k, body: v });
      return { exitCode: 0, stdout: JSON.stringify(out), stderr: "", policy: null };
    }
    return { exitCode: 1, stdout: "", stderr: "unexpected", policy: null };
  };
}

const unprovisionedBd: HandoffStoreDeps["execBd"] = () => ({
  exitCode: 1,
  stdout: "",
  stderr: "bd: not provisioned",
  policy: null,
});

const fixedNow = () => new Date("2026-06-07T00:00:00Z");
// No currentRepoSlug → the per-repo guard is skipped (the CLI resolves the repo
// slug from the live git remote, which we don't control here). The cross-repo
// test sets its own currentRepoSlug to force the mismatch.
const depsWith = (execBd: HandoffStoreDeps["execBd"], extra: Partial<HandoffStoreDeps> = {}): HandoffCliDeps => ({
  store: { execBd, now: fixedNow, ...extra },
  appendAuditRow: () => {}, // no audit IO
});

const baseEnqueue = {
  target: "publisher",
  verb: "git.push",
  workUnitId: "GH-1",
  format: "plain" as const,
};

// ── enqueue ───────────────────────────────────────────────────────────────

describe("runHandoffEnqueue", () => {
  test("rejects an invalid --target with exit 2", async () => {
    const s = sink();
    expect(await runHandoffEnqueue({ ...baseEnqueue, target: "nope" }, s.out)).toBe(2);
    expect(s.errors[0]).toMatch(/must be one of/);
  });

  test("created → logs the envelope and exits 0 (plain + json)", async () => {
    const s = sink();
    expect(await runHandoffEnqueue(baseEnqueue, s.out, depsWith(makeFakeBd()))).toBe(0);
    expect(s.logs[0]).toMatch(/handoff enqueued/);

    const j = sink();
    await runHandoffEnqueue({ ...baseEnqueue, format: "json" }, j.out, depsWith(makeFakeBd()));
    expect(JSON.parse(j.logs[0]!).label).toBe("enqueued");
  });

  test("a repeated enqueue is idempotent (duplicate, exit 0)", async () => {
    const rows = new Map<string, string>();
    const deps = depsWith(makeFakeBd(rows));
    const s = sink();
    await runHandoffEnqueue(baseEnqueue, s.out, deps);
    expect(await runHandoffEnqueue(baseEnqueue, s.out, deps)).toBe(0);
    expect(s.logs[1]).toMatch(/handoff duplicate/);
  });

  test("bd unprovisioned fails closed with exit 3", async () => {
    const s = sink();
    expect(await runHandoffEnqueue(baseEnqueue, s.out, depsWith(unprovisionedBd))).toBe(3);
    expect(s.errors[0]).toMatch(/bd unprovisioned/);
  });

  test("cross-repo enqueue is refused with exit 4", async () => {
    const s = sink();
    const deps: HandoffCliDeps = {
      store: { execBd: makeFakeBd(), now: fixedNow, currentRepoSlug: () => "other/repo" },
      appendAuditRow: () => {},
    };
    expect(await runHandoffEnqueue({ ...baseEnqueue, repoSlug: "test/repo" } as never, s.out, deps)).toBe(4);
    expect(s.errors[0]).toMatch(/cross-repo refused/);
  });

  test("a malformed --args literal throws (loadArgs guard)", async () => {
    const s = sink();
    await expect(
      runHandoffEnqueue({ ...baseEnqueue, argsLiteral: "{ not json" } as never, s.out, depsWith(makeFakeBd())),
    ).rejects.toThrow(/could not be parsed as JSON/);
  });
});

// ── status ──────────────────────────────────────────────────────────────────

describe("runHandoffStatus", () => {
  test("rejects an invalid --target with exit 2", async () => {
    const s = sink();
    expect(await runHandoffStatus({ target: "nope", format: "plain" }, s.out)).toBe(2);
  });

  test("empty queue reports 'no rows'", async () => {
    const s = sink();
    expect(await runHandoffStatus({ format: "plain" }, s.out, depsWith(makeFakeBd()))).toBe(0);
    expect(s.logs[0]).toMatch(/no rows/);
  });

  test("json format emits the (empty) array", async () => {
    const s = sink();
    await runHandoffStatus({ format: "json" }, s.out, depsWith(makeFakeBd()));
    expect(JSON.parse(s.logs[0]!)).toEqual([]);
  });

  test("lists an enqueued row, filtered by a valid --target (plain)", async () => {
    const rows = new Map<string, string>();
    const deps = depsWith(makeFakeBd(rows));
    await runHandoffEnqueue(baseEnqueue, sink().out, deps);
    const s = sink();
    // A valid --target exercises the target-assignment + scoped scan.
    expect(await runHandoffStatus({ target: "publisher", format: "plain" }, s.out, deps)).toBe(0);
    expect(s.logs[0]).toMatch(/git\.push/);
  });
});

// ── enqueue: --args-file ──────────────────────────────────────────────────────

describe("runHandoffEnqueue --args-file", () => {
  const dir = mkdtempSync(join(tmpdir(), "prx-handoff-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("reads + parses an args file", async () => {
    const f = join(dir, "args.json");
    writeFileSync(f, JSON.stringify({ k: "v" }));
    const s = sink();
    expect(await runHandoffEnqueue({ ...baseEnqueue, argsFile: f } as never, s.out, depsWith(makeFakeBd()))).toBe(0);
  });

  test("a malformed args file throws", async () => {
    const f = join(dir, "bad.json");
    writeFileSync(f, "{ not json");
    await expect(
      runHandoffEnqueue({ ...baseEnqueue, argsFile: f } as never, sink().out, depsWith(makeFakeBd())),
    ).rejects.toThrow(/--args-file .* could not be parsed/);
  });
});

// ── drain ─────────────────────────────────────────────────────────────────

describe("runHandoffDrain", () => {
  test("rejects an invalid --actor with exit 2", async () => {
    const s = sink();
    expect(await runHandoffDrain({ actor: "nope", once: true, max: 1, format: "plain" }, s.out)).toBe(2);
  });

  test("an empty queue drains nothing and exits 0 (plain + json)", async () => {
    const deps: HandoffCliDeps = { drain: { execBd: makeFakeBd(), appendAuditRow: () => {} } };
    const s = sink();
    expect(await runHandoffDrain({ actor: "noop", once: true, max: 1, format: "plain" }, s.out, deps)).toBe(0);
    expect(s.logs[0]).toMatch(/drained 0/);

    const j = sink();
    await runHandoffDrain({ actor: "noop", once: true, max: 1, format: "json" }, j.out, deps);
    expect(JSON.parse(j.logs[0]!).drained).toBe(0);
  });

  test("drains a pending noop handoff and logs the per-outcome line", async () => {
    const rows = new Map<string, string>();
    // enqueue to noop (the test adapter), then drain it through the same store.
    await runHandoffEnqueue({ ...baseEnqueue, target: "noop" }, sink().out, depsWith(makeFakeBd(rows)));
    const s = sink();
    const code = await runHandoffDrain(
      { actor: "noop", once: true, max: 1, format: "plain" },
      s.out,
      { drain: { execBd: makeFakeBd(rows), appendAuditRow: () => {} } },
    );
    // The summary line plus at least one `  <id> → <outcome>` per-outcome line.
    expect(s.logs.join("\n")).toMatch(/→/);
    expect(code === 0 || code === 1).toBe(true);
  });
});

// ── replay ──────────────────────────────────────────────────────────────────

describe("runHandoffReplay", () => {
  test("no row for the id → exit 1", async () => {
    const s = sink();
    expect(await runHandoffReplay({ id: "missing", format: "plain" }, s.out, depsWith(makeFakeBd()))).toBe(1);
    expect(s.errors[0]).toMatch(/no row found/);
  });

  test("a pending (non-replayable) row → exit 2", async () => {
    const rows = new Map<string, string>();
    const deps = depsWith(makeFakeBd(rows));
    // enqueue creates a pending row; capture its id from the stored envelope.
    await runHandoffEnqueue(baseEnqueue, sink().out, deps);
    const stored = JSON.parse([...rows.values()][0]!);
    const s = sink();
    expect(await runHandoffReplay({ id: stored.id, format: "plain" }, s.out, deps)).toBe(2);
    expect(s.errors[0]).toMatch(/only abandoned\/failed rows are replayable/);
  });

  test("an abandoned row re-enqueues (duplicate of the still-present original) → exit 0", async () => {
    const rows = new Map<string, string>();
    const deps = depsWith(makeFakeBd(rows));
    await runHandoffEnqueue(baseEnqueue, sink().out, deps);
    // Flip the stored row to abandoned so it becomes replayable.
    const [key, body] = [...rows.entries()][0]!;
    const env = JSON.parse(body);
    env.status = "abandoned";
    rows.set(key, JSON.stringify(env));
    const s = sink();
    expect(await runHandoffReplay({ id: env.id, format: "plain" }, s.out, deps)).toBe(0);
    expect(s.logs[0]).toMatch(/handoff duplicate/);
  });

  // Build a stored abandoned-envelope row (key, body) by enqueueing then flipping.
  async function abandonedRow(): Promise<{ key: string; body: string; id: string }> {
    const rows = new Map<string, string>();
    await runHandoffEnqueue(baseEnqueue, sink().out, depsWith(makeFakeBd(rows)));
    const [key, body] = [...rows.entries()][0]!;
    const env = JSON.parse(body);
    env.status = "abandoned";
    return { key, body: JSON.stringify(env), id: env.id };
  }

  // A bd where the broad scan (getHandoff) sees the abandoned row but the
  // dedup-prefix scan does not — so the re-enqueue lands as `created`.
  const prefixAwareBd = (row: { key: string; body: string }, rememberCode: number): HandoffStoreDeps["execBd"] =>
    (opts: BdExecOptions): BdExecResult => {
      if (opts.subcommand === "remember") return { exitCode: rememberCode, stdout: "{}", stderr: "x", policy: null };
      if (opts.subcommand === "memories") {
        const body = (opts.args[0] as string) === "handoff/" ? JSON.stringify([row]) : "[]";
        return { exitCode: 0, stdout: body, stderr: "", policy: null };
      }
      return { exitCode: 1, stdout: "", stderr: "", policy: null };
    };

  test("an abandoned row with no dedup match re-enqueues as created → exit 0", async () => {
    const row = await abandonedRow();
    const s = sink();
    expect(
      await runHandoffReplay({ id: row.id, format: "plain" }, s.out, depsWith(prefixAwareBd(row, 0))),
    ).toBe(0);
    expect(s.logs[0]).toMatch(/handoff replayed/);
  });

  test("a bd write failure on re-enqueue → exit 3", async () => {
    const row = await abandonedRow();
    const s = sink();
    expect(
      await runHandoffReplay({ id: row.id, format: "plain" }, s.out, depsWith(prefixAwareBd(row, 1))),
    ).toBe(3);
    expect(s.errors[0]).toMatch(/bd unprovisioned/);
  });

  test("re-enqueue refused cross-repo → exit 4", async () => {
    const row = await abandonedRow();
    const slug = JSON.parse(row.body).repoSlug as string;
    const s = sink();
    // currentRepoSlug differs from the row's repoSlug → per-repo guard refuses.
    expect(
      await runHandoffReplay(
        { id: row.id, format: "plain" },
        s.out,
        depsWith(prefixAwareBd(row, 0), { currentRepoSlug: () => `${slug}-mismatch` }),
      ),
    ).toBe(4);
    expect(s.errors[0]).toMatch(/cross-repo refused/);
  });
});
