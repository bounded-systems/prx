// GH-1407 — Unit tests for the Anthropic prompt-cache projector.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  projectAnthropicDiamond,
  projectAnthropicUsage,
  resolveWindowFloor,
} from "../../src/services/anthropic.ts";

function makeDb(): Database {
  // The projector only reads the generic `events` table. Use the same DDL
  // shape the ingester writes; we don't need the full audit-store views.
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE events (
      event_id      TEXT PRIMARY KEY,
      ts            TEXT NOT NULL,
      actor         TEXT NOT NULL,
      action        TEXT NOT NULL,
      uow_id        TEXT,
      artifact_type TEXT,
      artifact_ref  TEXT,
      raw_json      TEXT NOT NULL
    );
  `);
  return db;
}

let eventIdCounter = 0;

function seedUsage(
  db: Database,
  payload: {
    ts: string;
    profile?: string;
    actor?: string;
    workUnitId?: string;
    model?: string;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    total_cost_usd?: number;
  },
): void {
  const row = {
    ts: payload.ts,
    kind: "non-interactive-agent",
    subkind: "usage",
    profile: payload.profile,
    actor: payload.actor ?? "claude-code",
    workUnitId: payload.workUnitId,
    ...(payload.model ? { model: payload.model } : {}),
    input_tokens: payload.input_tokens ?? 0,
    output_tokens: payload.output_tokens ?? 0,
    cache_read_input_tokens: payload.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: payload.cache_creation_input_tokens ?? 0,
    total_cost_usd: payload.total_cost_usd ?? 0,
  };
  eventIdCounter += 1;
  db.run(
    `INSERT INTO events (event_id, ts, actor, action, uow_id, artifact_type, artifact_ref, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `t::${eventIdCounter}`,
      payload.ts,
      row.actor,
      "non-interactive-agent",
      payload.workUnitId ?? null,
      null,
      null,
      JSON.stringify(row),
    ],
  );
}

function seedNonUsage(db: Database, ts: string): void {
  // started rows are filtered out of the projector — only `usage` aggregates.
  const row = {
    ts,
    kind: "non-interactive-agent",
    subkind: "started",
    profile: "work-unit/claude",
    actor: "claude-code",
  };
  eventIdCounter += 1;
  db.run(
    `INSERT INTO events (event_id, ts, actor, action, uow_id, artifact_type, artifact_ref, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `t::${eventIdCounter}`,
      ts,
      "claude-code",
      "non-interactive-agent",
      null,
      null,
      null,
      JSON.stringify(row),
    ],
  );
}

describe("projectAnthropicUsage", () => {
  test("groups by profile and computes hit_rate against (input + cache_read)", () => {
    const db = makeDb();
    seedUsage(db, {
      ts: "2026-05-15T00:00:00Z",
      profile: "work-unit/claude",
      input_tokens: 100,
      cache_read_input_tokens: 400,
      cache_creation_input_tokens: 0,
      total_cost_usd: 0.01,
    });
    seedUsage(db, {
      ts: "2026-05-15T00:01:00Z",
      profile: "work-unit/claude",
      input_tokens: 100,
      cache_read_input_tokens: 400,
      total_cost_usd: 0.01,
    });
    seedUsage(db, {
      ts: "2026-05-15T00:02:00Z",
      profile: "user/claude",
      input_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 100,
    });

    const buckets = projectAnthropicUsage(db, { by: "profile" });
    expect(buckets.length).toBe(2);

    const workUnit = buckets.find((b) => b.bucket === "work-unit/claude")!;
    expect(workUnit.calls).toBe(2);
    expect(workUnit.input_tokens).toBe(200);
    expect(workUnit.cache_read_input_tokens).toBe(800);
    // 800 / (200 + 800) = 0.8
    expect(workUnit.hit_rate).toBeCloseTo(0.8, 5);
    expect(workUnit.total_cost_usd).toBeCloseTo(0.02, 5);

    // cache_creation does not count towards the hit-rate numerator.
    const user = buckets.find((b) => b.bucket === "user/claude")!;
    expect(user.hit_rate).toBe(0);
    expect(user.cache_creation_input_tokens).toBe(100);
  });

  test("ignores non-usage subkinds (started, completed, ...)", () => {
    const db = makeDb();
    seedNonUsage(db, "2026-05-15T00:00:00Z");
    seedUsage(db, {
      ts: "2026-05-15T00:00:01Z",
      profile: "work-unit/claude",
      input_tokens: 10,
      cache_read_input_tokens: 0,
    });
    const buckets = projectAnthropicUsage(db);
    expect(buckets.length).toBe(1);
    expect(buckets[0]!.calls).toBe(1);
  });

  test("respects the `since` floor", () => {
    const db = makeDb();
    seedUsage(db, {
      ts: "2026-04-01T00:00:00Z",
      profile: "old",
      input_tokens: 10,
    });
    seedUsage(db, {
      ts: "2026-05-15T00:00:00Z",
      profile: "recent",
      input_tokens: 20,
    });
    const buckets = projectAnthropicUsage(db, { since: "2026-05-01T00:00:00Z" });
    expect(buckets.length).toBe(1);
    expect(buckets[0]!.bucket).toBe("recent");
  });

  test("groups by actor and workUnitId", () => {
    const db = makeDb();
    seedUsage(db, {
      ts: "2026-05-15T00:00:00Z",
      actor: "claude-code",
      workUnitId: "GH-1",
      profile: "work-unit/claude",
      input_tokens: 10,
    });
    seedUsage(db, {
      ts: "2026-05-15T00:00:01Z",
      actor: "haiku-classifier",
      workUnitId: "GH-2",
      profile: "user/claude",
      input_tokens: 10,
    });
    const byActor = projectAnthropicUsage(db, { by: "actor" });
    expect(byActor.map((b) => b.bucket).sort()).toEqual(["claude-code", "haiku-classifier"]);
    const byUnit = projectAnthropicUsage(db, { by: "workUnitId" });
    expect(byUnit.map((b) => b.bucket).sort()).toEqual(["GH-1", "GH-2"]);
  });

  test("groups by model, falling back to (unknown model) when absent", () => {
    const db = makeDb();
    seedUsage(db, {
      ts: "2026-05-15T00:00:00Z",
      model: "claude-opus-4-8",
      input_tokens: 100,
      cache_read_input_tokens: 800,
      total_cost_usd: 0.10,
    });
    seedUsage(db, {
      ts: "2026-05-15T00:01:00Z",
      model: "claude-opus-4-8",
      input_tokens: 50,
      cache_read_input_tokens: 400,
      total_cost_usd: 0.05,
    });
    seedUsage(db, {
      ts: "2026-05-15T00:02:00Z",
      model: "claude-haiku-4-5",
      input_tokens: 10,
      cache_read_input_tokens: 90,
      total_cost_usd: 0.001,
    });
    seedUsage(db, {
      ts: "2026-05-15T00:03:00Z",
      // no model field — falls back to (unknown model)
      input_tokens: 5,
    });

    const buckets = projectAnthropicUsage(db, { by: "model" });
    expect(buckets.length).toBe(3);

    const opus = buckets.find((b) => b.bucket === "claude-opus-4-8")!;
    expect(opus.calls).toBe(2);
    expect(opus.total_cost_usd).toBeCloseTo(0.15, 5);
    expect(opus.hit_rate).toBeCloseTo(1200 / 1350, 5);

    const haiku = buckets.find((b) => b.bucket === "claude-haiku-4-5")!;
    expect(haiku.calls).toBe(1);

    const unknown = buckets.find((b) => b.bucket === "(unknown model)")!;
    expect(unknown.calls).toBe(1);
  });

  test("returns hit_rate=0 when both input and cache_read are zero", () => {
    const db = makeDb();
    seedUsage(db, {
      ts: "2026-05-15T00:00:00Z",
      profile: "empty",
      input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    const buckets = projectAnthropicUsage(db);
    expect(buckets[0]!.hit_rate).toBe(0);
  });
});

describe("projectAnthropicDiamond", () => {
  function makeDbWithTransitions(): Database {
    const db = makeDb();
    db.exec(`
      CREATE TABLE transitions (
        id          TEXT PRIMARY KEY,
        issue       TEXT,
        state_from  TEXT NOT NULL,
        state_to    TEXT NOT NULL,
        actor       TEXT NOT NULL,
        artifact    TEXT,
        ts          TEXT NOT NULL,
        proof_commit TEXT,
        proof_checks_json TEXT
      );
    `);
    return db;
  }

  function seedTransition(
    db: Database,
    issue: string,
    state_to: string,
    ts: string,
  ): void {
    db.run(
      `INSERT INTO transitions (id, issue, state_from, state_to, actor, ts)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [`tr::${issue}::${ts}`, issue, "open", state_to, "test", ts],
    );
  }

  test("assigns work units to dominant model and computes completion_rate", () => {
    const db = makeDbWithTransitions();

    // GH-1: completed via merged, dominant model = opus (higher cost)
    seedUsage(db, { ts: "2026-05-15T00:00:00Z", workUnitId: "GH-1", model: "claude-opus-4-8", total_cost_usd: 5.0, input_tokens: 100, cache_read_input_tokens: 800 });
    seedUsage(db, { ts: "2026-05-15T00:01:00Z", workUnitId: "GH-1", model: "claude-haiku-4-5", total_cost_usd: 0.1, input_tokens: 10, cache_read_input_tokens: 50 });
    seedTransition(db, "GH-1", "merged", "2026-05-15T01:00:00Z");

    // GH-2: closed, dominant model = opus
    seedUsage(db, { ts: "2026-05-15T00:02:00Z", workUnitId: "GH-2", model: "claude-opus-4-8", total_cost_usd: 3.0, input_tokens: 60, cache_read_input_tokens: 400 });
    seedTransition(db, "GH-2", "closed", "2026-05-15T02:00:00Z");

    // GH-3: in_progress (no transition), dominant model = haiku
    seedUsage(db, { ts: "2026-05-15T00:03:00Z", workUnitId: "GH-3", model: "claude-haiku-4-5", total_cost_usd: 0.2, input_tokens: 20, cache_read_input_tokens: 80 });

    const points = projectAnthropicDiamond(db);

    const opus = points.find((p) => p.model === "claude-opus-4-8")!;
    expect(opus.work_units).toBe(2); // GH-1 and GH-2
    expect(opus.completed).toBe(1);
    expect(opus.closed).toBe(1);
    expect(opus.in_progress).toBe(0);
    expect(opus.completion_rate).toBeCloseTo(0.5, 5);
    expect(opus.total_cost_usd).toBeCloseTo(8.1, 5); // 5.1 (GH-1 total) + 3.0 (GH-2)

    const haiku = points.find((p) => p.model === "claude-haiku-4-5")!;
    expect(haiku.work_units).toBe(1); // GH-3
    expect(haiku.in_progress).toBe(1);
    expect(haiku.completion_rate).toBe(0);
  });

  test("returns empty when no work units have a workUnitId", () => {
    const db = makeDbWithTransitions();
    seedUsage(db, { ts: "2026-05-15T00:00:00Z", input_tokens: 10 }); // no workUnitId
    expect(projectAnthropicDiamond(db)).toEqual([]);
  });

  test("treats cleaned as completed", () => {
    const db = makeDbWithTransitions();
    seedUsage(db, { ts: "2026-05-15T00:00:00Z", workUnitId: "GH-10", model: "claude-opus-4-8", total_cost_usd: 1.0 });
    seedTransition(db, "GH-10", "cleaned", "2026-05-15T01:00:00Z");
    const points = projectAnthropicDiamond(db);
    expect(points[0]!.completed).toBe(1);
    expect(points[0]!.completion_rate).toBe(1);
  });

  test("latest transition wins when multiple transitions exist", () => {
    const db = makeDbWithTransitions();
    seedUsage(db, { ts: "2026-05-15T00:00:00Z", workUnitId: "GH-20", model: "claude-opus-4-8", total_cost_usd: 2.0 });
    seedTransition(db, "GH-20", "draft", "2026-05-15T01:00:00Z");
    seedTransition(db, "GH-20", "merged", "2026-05-15T02:00:00Z");
    const points = projectAnthropicDiamond(db);
    expect(points[0]!.completed).toBe(1);
  });
});

describe("resolveWindowFloor", () => {
  const fixedNow = new Date("2026-05-16T12:00:00Z");

  test("returns undefined when no window is given", () => {
    expect(resolveWindowFloor(undefined, fixedNow)).toBeUndefined();
    expect(resolveWindowFloor("", fixedNow)).toBeUndefined();
  });

  test("parses Nd, Nh, Nm into ISO floors relative to now", () => {
    expect(resolveWindowFloor("1d", fixedNow)).toBe("2026-05-15T12:00:00.000Z");
    expect(resolveWindowFloor("2h", fixedNow)).toBe("2026-05-16T10:00:00.000Z");
    expect(resolveWindowFloor("30m", fixedNow)).toBe("2026-05-16T11:30:00.000Z");
  });

  test("passes ISO timestamps through unchanged", () => {
    expect(resolveWindowFloor("2026-05-10T00:00:00Z", fixedNow)).toBe("2026-05-10T00:00:00Z");
  });

  test("rejects malformed window values", () => {
    expect(() => resolveWindowFloor("yesterday", fixedNow)).toThrow(/invalid --window/);
  });
});
