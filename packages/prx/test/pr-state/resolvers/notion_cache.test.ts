import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  invalidateFetchField,
  mergeFetch,
  mergeLookup,
  readTaskCache,
  type NotionFetch,
  type NotionLookup,
} from "../../../src/pr-state/resolvers/notion_cache.ts";

function tmpFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "prx-notion-cache-"));
  return join(dir, name);
}

const sampleLookup: NotionLookup = {
  pageId: "p1",
  title: "Sample title",
  url: "https://notion.so/p1",
};
const sampleFetch: NotionFetch = {
  title: "Fetched title",
  body: "body",
  state: "open",
  url: "https://notion.so/p1",
  fetchedAt: "2026-05-15T00:00:00.000Z",
};

describe("notion_cache", () => {
  test("mergeLookup followed by mergeFetch produces a record with both halves", () => {
    const file = tmpFile("FOO.json");
    mergeLookup(file, sampleLookup);
    mergeFetch(file, sampleFetch);

    const parsed = readTaskCache(file);
    expect(parsed).not.toBeNull();
    expect(parsed!.schemaVersion).toBe(1);
    expect(parsed!.lookup).toEqual(sampleLookup);
    expect(parsed!.fetch).toEqual(sampleFetch);
  });

  test("mergeFetch then mergeLookup preserves the fetch half", () => {
    const file = tmpFile("BAR.json");
    mergeFetch(file, sampleFetch);
    mergeLookup(file, sampleLookup);

    const parsed = readTaskCache(file);
    expect(parsed!.lookup).toEqual(sampleLookup);
    expect(parsed!.fetch).toEqual(sampleFetch);
  });

  test("invalidateFetchField keeps lookup intact", () => {
    const file = tmpFile("BAZ.json");
    mergeLookup(file, sampleLookup);
    mergeFetch(file, sampleFetch);

    invalidateFetchField(file);

    const parsed = readTaskCache(file);
    expect(parsed!.lookup).toEqual(sampleLookup);
    expect(parsed!.fetch).toBeUndefined();
  });

  test("invalidateFetchField unlinks the file when there is no lookup half to preserve", () => {
    const file = tmpFile("ONLY-FETCH.json");
    mergeFetch(file, sampleFetch);
    expect(existsSync(file)).toBe(true);

    invalidateFetchField(file);

    expect(existsSync(file)).toBe(false);
  });

  test("readTaskCache returns null on missing file, parse error, and schema mismatch", () => {
    const dir = mkdtempSync(join(tmpdir(), "prx-notion-cache-miss-"));

    expect(readTaskCache(join(dir, "missing.json"))).toBeNull();

    const garbage = join(dir, "garbage.json");
    writeFileSync(garbage, "not json{");
    expect(readTaskCache(garbage)).toBeNull();

    const wrongShape = join(dir, "wrong.json");
    writeFileSync(wrongShape, JSON.stringify({ random: "stuff" }));
    expect(readTaskCache(wrongShape)).toBeNull();

    // GH-867: future-versioned record is rejected as a miss rather than
    // silently downgraded.
    const futureVersion = join(dir, "future.json");
    writeFileSync(futureVersion, JSON.stringify({ schemaVersion: 2, lookup: sampleLookup }));
    expect(readTaskCache(futureVersion)).toBeNull();
  });

  test("atomic write: no stray .tmp file remains after mergeLookup", () => {
    const file = tmpFile("ATOMIC.json");
    mergeLookup(file, sampleLookup);

    const dir = join(file, "..");
    const entries = readdirSync(dir);
    const tmpFiles = entries.filter((e) => e.endsWith(".tmp"));
    expect(tmpFiles.length).toBe(0);
    // Final file is there with correct contents.
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      schemaVersion: 1,
      lookup: sampleLookup,
    });
  });
});
