// GH-1407 — Integration test for `prx services status`.
//
// Uses an in-memory audit DB seeded with synthetic non-interactive-agent
// rows; asserts the JSON envelope shape and plain-text rendering.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  runServicesDiamond,
  runServicesSeries,
  runServicesStatus,
} from "../../src/services/cli.ts";

function seedDb(): Database {
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
  const rows = [
    {
      ts: "2026-05-15T00:00:00Z",
      profile: "work-unit/claude",
      input: 50,
      cache_read: 450,
    },
    {
      ts: "2026-05-15T00:01:00Z",
      profile: "work-unit/claude",
      input: 50,
      cache_read: 450,
    },
  ];
  for (const [i, r] of rows.entries()) {
    const payload = {
      ts: r.ts,
      kind: "non-interactive-agent",
      subkind: "usage",
      profile: r.profile,
      actor: "claude-code",
      input_tokens: r.input,
      output_tokens: 10,
      cache_read_input_tokens: r.cache_read,
      cache_creation_input_tokens: 0,
      total_cost_usd: 0.001,
    };
    db.run(`INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
      `t-${i}`,
      r.ts,
      "claude-code",
      "non-interactive-agent",
      null,
      null,
      null,
      JSON.stringify(payload),
    ]);
  }
  return db;
}

function seedDbWithTransitions(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE events (
      event_id TEXT PRIMARY KEY, ts TEXT NOT NULL, actor TEXT NOT NULL,
      action TEXT NOT NULL, uow_id TEXT, artifact_type TEXT,
      artifact_ref TEXT, raw_json TEXT NOT NULL
    );
    CREATE TABLE transitions (
      id TEXT PRIMARY KEY, issue TEXT, state_from TEXT NOT NULL,
      state_to TEXT NOT NULL, actor TEXT NOT NULL, artifact TEXT,
      ts TEXT NOT NULL, proof_commit TEXT, proof_checks_json TEXT
    );
  `);
  // GH-1: merged (completed), model = claude-opus-4-8
  db.run(`INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
    "e-1",
    "2026-05-15T00:00:00Z",
    "claude-code",
    "non-interactive-agent",
    "GH-1",
    null,
    null,
    JSON.stringify({
      ts: "2026-05-15T00:00:00Z",
      kind: "non-interactive-agent",
      subkind: "usage",
      workUnitId: "GH-1",
      model: "claude-opus-4-8",
      input_tokens: 100,
      cache_read_input_tokens: 800,
      total_cost_usd: 5.0,
    }),
  ]);
  db.run(`INSERT INTO transitions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    "tr-1",
    "GH-1",
    "open",
    "merged",
    "test",
    null,
    "2026-05-15T01:00:00Z",
    null,
    null,
  ]);
  // GH-2: in_progress (no transition), model = claude-haiku-4-5
  db.run(`INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
    "e-2",
    "2026-05-15T00:01:00Z",
    "claude-code",
    "non-interactive-agent",
    "GH-2",
    null,
    null,
    JSON.stringify({
      ts: "2026-05-15T00:01:00Z",
      kind: "non-interactive-agent",
      subkind: "usage",
      workUnitId: "GH-2",
      model: "claude-haiku-4-5",
      input_tokens: 10,
      cache_read_input_tokens: 90,
      total_cost_usd: 0.2,
    }),
  ]);
  return db;
}

describe("runServicesDiamond", () => {
  test("--format=json emits a structured envelope with points", () => {
    const db = seedDbWithTransitions();
    const logs: string[] = [];
    const code = runServicesDiamond(
      { format: "json" },
      { log: (l) => logs.push(l), error: () => {} },
      { db },
    );
    expect(code).toBe(0);
    expect(logs.length).toBe(1);
    const parsed = JSON.parse(logs[0]!) as {
      plane: string;
      points: Array<{ model: string; work_units: number; completion_rate: number }>;
    };
    expect(parsed.plane).toBe("anthropic");
    const opus = parsed.points.find((p) => p.model === "claude-opus-4-8")!;
    expect(opus.work_units).toBe(1);
    expect(opus.completion_rate).toBe(1);
    const haiku = parsed.points.find((p) => p.model === "claude-haiku-4-5")!;
    expect(haiku.completion_rate).toBe(0);
  });

  test("plain format prints a header and one row per model", () => {
    const db = seedDbWithTransitions();
    const logs: string[] = [];
    const code = runServicesDiamond(
      { format: "plain" },
      { log: (l) => logs.push(l), error: () => {} },
      { db },
    );
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes("diamond"))).toBe(true);
    expect(logs.some((l) => l.includes("claude-opus-4-8"))).toBe(true);
    expect(logs.some((l) => l.includes("claude-haiku-4-5"))).toBe(true);
  });

  test("empty data prints the absent-rows hint", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE events (
        event_id TEXT PRIMARY KEY, ts TEXT NOT NULL, actor TEXT NOT NULL,
        action TEXT NOT NULL, uow_id TEXT, artifact_type TEXT,
        artifact_ref TEXT, raw_json TEXT NOT NULL
      );
      CREATE TABLE transitions (
        id TEXT PRIMARY KEY, issue TEXT, state_from TEXT NOT NULL,
        state_to TEXT NOT NULL, actor TEXT NOT NULL, artifact TEXT,
        ts TEXT NOT NULL, proof_commit TEXT, proof_checks_json TEXT
      );
    `);
    const logs: string[] = [];
    const code = runServicesDiamond(
      { format: "plain" },
      { log: (l) => logs.push(l), error: () => {} },
      { db },
    );
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes("no work-unit cost data found"))).toBe(true);
  });
});

describe("runServicesSeries", () => {
  test("--format=json emits structured points with tier and completion_rate", () => {
    const db = seedDbWithTransitions();
    const logs: string[] = [];
    const code = runServicesSeries(
      { format: "json" },
      { log: (l) => logs.push(l), error: () => {} },
      { db },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(logs[0]!) as {
      plane: string;
      points: Array<{ model: string; tier: string; completion_rate: number }>;
    };
    expect(parsed.plane).toBe("anthropic");
    expect(parsed.points.length).toBeGreaterThan(0);
    expect(parsed.points.every((p) => typeof p.tier === "string")).toBe(true);
    expect(parsed.points.every((p) => typeof p.completion_rate === "number")).toBe(true);
  });

  test("plain format prints a header and model rows grouped by tier", () => {
    const db = seedDbWithTransitions();
    const logs: string[] = [];
    const code = runServicesSeries(
      { format: "plain" },
      { log: (l) => logs.push(l), error: () => {} },
      { db },
    );
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes("series"))).toBe(true);
    expect(logs.some((l) => l.includes("claude-opus-4-8") || l.includes("claude-haiku-4-5"))).toBe(
      true,
    );
  });
});

describe("runServicesStatus", () => {
  test("--anthropic --format=json emits a structured envelope per bucket", () => {
    const db = seedDb();
    const logs: string[] = [];
    const code = runServicesStatus(
      { anthropic: true, by: "profile", format: "json" },
      {
        log: (l) => logs.push(l),
        error: () => {},
      },
      { db },
    );
    expect(code).toBe(0);
    expect(logs.length).toBe(1);
    const parsed = JSON.parse(logs[0]!) as {
      plane: string;
      by: string;
      buckets: Array<{ bucket: string; hit_rate: number; calls: number }>;
    };
    expect(parsed.plane).toBe("anthropic");
    expect(parsed.by).toBe("profile");
    expect(parsed.buckets[0]!.bucket).toBe("work-unit/claude");
    expect(parsed.buckets[0]!.calls).toBe(2);
    // 900 / (100 + 900) = 0.9
    expect(parsed.buckets[0]!.hit_rate).toBeCloseTo(0.9, 5);
  });

  test("plain format prints one row per bucket with the hit rate", () => {
    const db = seedDb();
    const logs: string[] = [];
    const code = runServicesStatus(
      { anthropic: true, by: "profile", format: "plain" },
      {
        log: (l) => logs.push(l),
        error: () => {},
      },
      { db },
    );
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes("work-unit/claude"))).toBe(true);
    expect(logs.some((l) => l.includes("hit_rate=90.0%"))).toBe(true);
  });

  test("missing --anthropic exits non-zero with a guidance line", () => {
    const db = seedDb();
    const logs: string[] = [];
    const errors: string[] = [];
    const code = runServicesStatus(
      { anthropic: false, format: "plain" },
      {
        log: (l) => logs.push(l),
        error: (l) => errors.push(l),
      },
      { db },
    );
    expect(code).toBe(2);
    expect(errors.some((l) => l.includes("--anthropic is required"))).toBe(true);
  });

  test("empty audit store reports the absent-rows hint", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE events (
        event_id TEXT PRIMARY KEY, ts TEXT NOT NULL, actor TEXT NOT NULL,
        action TEXT NOT NULL, uow_id TEXT, artifact_type TEXT,
        artifact_ref TEXT, raw_json TEXT NOT NULL
      );
    `);
    const logs: string[] = [];
    const code = runServicesStatus(
      { anthropic: true, by: "profile", format: "plain" },
      {
        log: (l) => logs.push(l),
        error: () => {},
      },
      { db },
    );
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes("no non-interactive-agent/usage rows found"))).toBe(true);
  });
});
