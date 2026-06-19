// GH-1407 — Integration test for `prx services status`.
//
// Uses an in-memory audit DB seeded with synthetic non-interactive-agent
// rows; asserts the JSON envelope shape and plain-text rendering.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { runServicesStatus } from "../../src/services/cli.ts";

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
