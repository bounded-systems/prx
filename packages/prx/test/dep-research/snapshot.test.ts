import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSnapshot, formatRunId, writeSnapshot } from "../../src/dep-research/snapshot.ts";
import { DepSnapshot } from "../../src/dep-research/schemas.ts";

describe("buildSnapshot", () => {
  test("digests successful paths into sha256 + byte_len records", () => {
    const snapshot = buildSnapshot({
      dep: "xstate",
      runId: "20260505T120000Z",
      fetchedAt: "2026-05-05T12:00:00.000Z",
      fetched: {
        "a.ts": Buffer.from("hello", "utf8"),
        "b.ts": Buffer.from("", "utf8"),
      },
      failures: {},
    });

    expect(snapshot.dep).toBe("xstate");
    expect(snapshot.run_id).toBe("20260505T120000Z");
    expect(snapshot.run_state).toBe("ok");
    // sha256("hello") in lowercase hex.
    expect(snapshot.source_sha256["a.ts"]).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(snapshot.source_byte_len["a.ts"]).toBe(5);
    expect(snapshot.source_byte_len["b.ts"]).toBe(0);
  });

  test("flips run_state to 'failed' when any path is in failures", () => {
    const snapshot = buildSnapshot({
      dep: "beads",
      runId: "20260505T120000Z",
      fetchedAt: "2026-05-05T12:00:00.000Z",
      fetched: { "schema.sql": Buffer.from("CREATE TABLE x") },
      failures: { "missing.go": "read failed: ENOENT" },
    });
    expect(snapshot.run_state).toBe("failed");
    // Failed paths are absent from sha256/byte_len records.
    expect(snapshot.source_sha256["missing.go"]).toBeUndefined();
    expect(snapshot.source_byte_len["missing.go"]).toBeUndefined();
    // Successful paths still appear.
    expect(snapshot.source_sha256["schema.sql"]).toMatch(/^[0-9a-f]{64}$/);
  });

  test("output round-trips through DepSnapshot.parse", () => {
    const built = buildSnapshot({
      dep: "x",
      runId: "20260505T000000Z",
      fetchedAt: "2026-05-05T00:00:00.000Z",
      fetched: { p: Buffer.from("k") },
      failures: {},
    });
    expect(() => DepSnapshot.parse(built)).not.toThrow();
  });

  test("is deterministic for the same input", () => {
    const args = {
      dep: "x",
      runId: "20260505T000000Z",
      fetchedAt: "2026-05-05T00:00:00.000Z",
      fetched: { p: Buffer.from("payload") },
      failures: {},
    } as const;
    expect(buildSnapshot(args)).toEqual(buildSnapshot(args));
  });
});

describe("writeSnapshot", () => {
  function tmpBase(): string {
    return mkdtempSync(join(tmpdir(), "dep-research-write-"));
  }

  test("materializes <baseDir>/<dep>/<runId>/snapshot.json", () => {
    const baseDir = tmpBase();
    const snapshot = buildSnapshot({
      dep: "xstate",
      runId: "20260505T120000Z",
      fetchedAt: "2026-05-05T12:00:00.000Z",
      fetched: { p: Buffer.from("k") },
      failures: {},
    });
    const finalDir = writeSnapshot(snapshot, baseDir);

    expect(finalDir).toBe(join(baseDir, "xstate", "20260505T120000Z"));
    const onDisk = JSON.parse(readFileSync(join(finalDir, "snapshot.json"), "utf8"));
    expect(DepSnapshot.parse(onDisk)).toEqual(snapshot);
  });

  test("leaves no .tmp.<runId> sibling after a successful write", () => {
    const baseDir = tmpBase();
    writeSnapshot(
      buildSnapshot({
        dep: "x",
        runId: "20260505T010203Z",
        fetchedAt: "2026-05-05T01:02:03.000Z",
        fetched: { p: Buffer.from("k") },
        failures: {},
      }),
      baseDir,
    );
    const siblings = readdirSync(join(baseDir, "x"));
    expect(siblings).toEqual(["20260505T010203Z"]);
    for (const name of siblings) {
      expect(name.startsWith(".tmp")).toBe(false);
    }
  });

  test("is safe to invoke against an already-existing dep dir", () => {
    const baseDir = tmpBase();
    const first = buildSnapshot({
      dep: "x",
      runId: "20260505T000000Z",
      fetchedAt: "2026-05-05T00:00:00.000Z",
      fetched: { p: Buffer.from("a") },
      failures: {},
    });
    const second = buildSnapshot({
      dep: "x",
      runId: "20260505T000001Z",
      fetchedAt: "2026-05-05T00:00:01.000Z",
      fetched: { p: Buffer.from("b") },
      failures: {},
    });
    writeSnapshot(first, baseDir);
    writeSnapshot(second, baseDir);
    expect(existsSync(join(baseDir, "x", "20260505T000000Z", "snapshot.json"))).toBe(true);
    expect(existsSync(join(baseDir, "x", "20260505T000001Z", "snapshot.json"))).toBe(true);
  });
});

describe("formatRunId", () => {
  test("renders UTC YYYYMMDDTHHMMSSZ", () => {
    expect(formatRunId(new Date("2026-05-05T12:34:56.000Z"))).toBe("20260505T123456Z");
  });

  test("zero-pads single-digit fields", () => {
    expect(formatRunId(new Date("2026-01-02T03:04:05.000Z"))).toBe("20260102T030405Z");
  });
});
