// GH-1510 — tests for the ready query + cache layer.
//
// GH-1012 retired beads: the old bd runner path (the removed graph query, the
// removed runner type, and `queryBdReady({ runner })`) is gone. `queryBdReady`
// now resolves ONLY via
// Front Desk (`frontDeskReady`, injectable via the `frontDesk` option). These
// tests cover the surviving surface: source selection, `filterBlocked`, and the
// ready_cache layer (driven through a stub `fds` binary, since `getBdReady`
// queries Front Desk with no runner seam).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BdReadyCacheSchema,
  BdReadyExplainEnvelopeSchema,
  filterBlocked,
  queryBdReady,
  type BdReadyCandidate,
} from "../../src/beads/ready.ts";
import {
  DEFAULT_READY_TTL_SECONDS,
  cacheFilePath,
  getBdReady,
  loadReadyTtlSeconds,
  readCache,
  writeCache,
} from "../../src/beads/ready_cache.ts";

const MIXED_FIXTURE_PATH = new URL("./fixtures/bd-ready-mixed.json", import.meta.url).pathname;
const mixedFixture = BdReadyExplainEnvelopeSchema.parse(
  JSON.parse(readFileSync(MIXED_FIXTURE_PATH, "utf8")),
);

// A stub `fds graph --json` payload with a single ready item. Front Desk maps
// item `{ number: 1, repository: "prx" }` → candidate id `GH-1`.
const FDS_STUB_JSON = JSON.stringify({
  source: "front-desk",
  syncedAt: "2026-01-01T00:00:00Z",
  ready: [
    {
      number: 1,
      repository: "prx",
      kind: "task",
      title: "Ready one",
      status: "Todo",
      effort: 1,
      value: 1,
      score: 1,
      ageDays: 0,
    },
  ],
  blocked: [],
  edges: [],
});

/**
 * Write an executable stub `fds` into `dir` that emits `FDS_STUB_JSON`, and
 * point `PRX_FRONTDESK_BIN` at it. Returns the script path. This is the seam
 * `getBdReady` uses to reach Front Desk (it takes no runner).
 */
function installFdsStub(dir: string): string {
  const script = join(dir, "fds-stub.sh");
  writeFileSync(script, `#!/bin/sh\ncat <<'JSON'\n${FDS_STUB_JSON}\nJSON\n`, "utf8");
  chmodSync(script, 0o755);
  process.env.PRX_FRONTDESK_BIN = script;
  return script;
}

// Restore PRX_READY_SOURCE around the source-selection tests, which mutate it.
const PRIOR_READY_SOURCE = process.env.PRX_READY_SOURCE;
afterEach(() => {
  if (PRIOR_READY_SOURCE === undefined) delete process.env.PRX_READY_SOURCE;
  else process.env.PRX_READY_SOURCE = PRIOR_READY_SOURCE;
});

describe("ready source selection (GH-1010)", () => {
  const stubResult = { ready: [], blocked: [], raw: "{}" };

  test("default source is frontdesk (no env) — uses the injected Front Desk reader", () => {
    delete process.env.PRX_READY_SOURCE;
    let called = false;
    const out = queryBdReady({
      cwd: "/repo",
      frontDesk: () => {
        called = true;
        return stubResult;
      },
    });
    expect(called).toBe(true);
    expect(out).toBe(stubResult);
  });

  test("explicit source=frontdesk uses the injected Front Desk reader", () => {
    process.env.PRX_READY_SOURCE = "bd";
    let called = false;
    queryBdReady({
      cwd: "/repo",
      source: "frontdesk",
      frontDesk: () => {
        called = true;
        return stubResult;
      },
    });
    expect(called).toBe(true);
  });
});

describe("filterBlocked (I-BD1 gate)", () => {
  const openIds = new Set<string>([
    "ai-home-r1",
    "ai-home-r2",
    "ai-home-child-1",
    "ai-home-b1",
    "ai-home-b2",
    "ai-home-parent-1",
  ]);

  test("removes items whose blocked_by intersects open ids", () => {
    const result = filterBlocked(mixedFixture.blocked as BdReadyCandidate[], [], openIds);
    expect(result.map((c) => c.id)).toEqual(["ai-home-b2"]);
  });

  test("keeps items whose only blockers are closed", () => {
    const result = filterBlocked([mixedFixture.blocked[1]!], [], openIds);
    expect(result.map((c) => c.id)).toEqual(["ai-home-b2"]);
  });

  test("supplemental edges (kind=blocks) also gate", () => {
    const candidate = { ...mixedFixture.ready[0]!, blocked_by: [] };
    const filtered = filterBlocked(
      [candidate],
      [{ from: candidate.id, to: "ai-home-r2", kind: "blocks" }],
      openIds,
    );
    expect(filtered).toHaveLength(0);
  });

  test("non-blocks edges (parent-child, relates_to, etc) do not gate", () => {
    const candidate = { ...mixedFixture.ready[0]!, blocked_by: [] };
    const filtered = filterBlocked(
      [candidate],
      [{ from: candidate.id, to: "ai-home-r2", kind: "parent-child" }],
      openIds,
    );
    expect(filtered).toHaveLength(1);
  });
});

describe("ready cache (atomic write + sync-if-stale)", () => {
  let repoPath: string;
  const PRIOR_FRONTDESK_BIN = process.env.PRX_FRONTDESK_BIN;
  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), "bd-ready-cache-"));
    installFdsStub(repoPath);
  });
  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
    if (PRIOR_FRONTDESK_BIN === undefined) delete process.env.PRX_FRONTDESK_BIN;
    else process.env.PRX_FRONTDESK_BIN = PRIOR_FRONTDESK_BIN;
  });

  test("first call refreshes (no cache) and writes an atomic file", () => {
    const result = getBdReady(repoPath, { ttlSeconds: 60 });
    expect(result.refreshed).toBe(true);
    expect(result.stale).toBe(false);
    expect(result.cache.ready.map((c) => c.id)).toEqual(["GH-1"]);

    const path = cacheFilePath(repoPath);
    expect(existsSync(path)).toBe(true);
    // No tmp leftovers — atomic rename wipes them.
    const dirEntries = readdirSync(join(repoPath, ".beads", "cache"));
    expect(dirEntries.filter((n) => n.endsWith(".tmp"))).toEqual([]);
    // The persisted file parses under the schema.
    BdReadyCacheSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  });

  test("second call within TTL serves cached envelope without re-querying", () => {
    const first = getBdReady(repoPath, { ttlSeconds: 60 });
    const second = getBdReady(repoPath, { ttlSeconds: 60 });
    expect(second.refreshed).toBe(false);
    expect(second.stale).toBe(false);
    // Same run_id ⇒ served from the on-disk cache, not a fresh query.
    expect(second.cache.run_id).toBe(first.cache.run_id);
  });

  test("stale cache is detected and refreshed (I-BD3 path)", () => {
    // Hand-write a cache file with a queried_at 3600s in the past.
    mkdirSync(join(repoPath, ".beads", "cache"), { recursive: true });
    const stale = {
      run_id: "stale-run",
      queried_at: new Date(Date.now() - 3600_000).toISOString(),
      ttl_seconds: 60,
      ready: [],
      blocked: [],
      edges: [],
    };
    writeFileSync(cacheFilePath(repoPath), JSON.stringify(stale), "utf8");

    const result = getBdReady(repoPath, { ttlSeconds: 60 });
    expect(result.stale).toBe(true);
    expect(result.refreshed).toBe(true);
    expect(result.cache.ready).toHaveLength(1);
  });

  test("force=true refreshes even when cache is fresh", () => {
    const first = getBdReady(repoPath, { ttlSeconds: 3600 });
    const result = getBdReady(repoPath, { force: true, ttlSeconds: 3600 });
    expect(result.refreshed).toBe(true);
    // A fresh query mints a new run_id.
    expect(result.cache.run_id).not.toBe(first.cache.run_id);
  });

  test("invalid cache JSON is treated as missing", () => {
    mkdirSync(join(repoPath, ".beads", "cache"), { recursive: true });
    writeFileSync(cacheFilePath(repoPath), "not-json {{", "utf8");
    const result = getBdReady(repoPath, { ttlSeconds: 60 });
    expect(result.refreshed).toBe(true);
  });

  test("I-BD2: writeCache never leaves a partial file when JSON.stringify is OK", () => {
    // Write a valid cache, then list dir — only the final file exists, no
    // stray *.tmp entries.
    writeCache(repoPath, {
      run_id: "r",
      queried_at: new Date().toISOString(),
      ttl_seconds: 60,
      ready: [],
      blocked: [],
      edges: [],
    });
    const entries = readdirSync(join(repoPath, ".beads", "cache"));
    expect(entries).toEqual(["ready.json"]);
    expect(statSync(cacheFilePath(repoPath)).isFile()).toBe(true);
  });

  test("readCache returns null when cache is missing", () => {
    expect(readCache(repoPath)).toBeNull();
  });
});

describe("loadReadyTtlSeconds (prx.toml [beads] ready_ttl_seconds)", () => {
  let repoPath: string;
  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), "ready-ttl-toml-"));
  });
  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  test("returns default when prx.toml is missing", () => {
    expect(loadReadyTtlSeconds(repoPath)).toBe(DEFAULT_READY_TTL_SECONDS);
  });

  test("parses an explicit override", () => {
    writeFileSync(
      join(repoPath, "prx.toml"),
      [`[beads]`, `ready_ttl_seconds = 30`, ``].join("\n"),
      "utf8",
    );
    expect(loadReadyTtlSeconds(repoPath)).toBe(30);
  });

  test("ignores non-positive values", () => {
    writeFileSync(
      join(repoPath, "prx.toml"),
      [`[beads]`, `ready_ttl_seconds = 0`, ``].join("\n"),
      "utf8",
    );
    expect(loadReadyTtlSeconds(repoPath)).toBe(DEFAULT_READY_TTL_SECONDS);
  });

  test("ignores entries outside the [beads] section", () => {
    writeFileSync(
      join(repoPath, "prx.toml"),
      [`[worktree]`, `ready_ttl_seconds = 999`, ``].join("\n"),
      "utf8",
    );
    expect(loadReadyTtlSeconds(repoPath)).toBe(DEFAULT_READY_TTL_SECONDS);
  });
});
