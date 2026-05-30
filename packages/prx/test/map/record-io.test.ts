import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listMapNames,
  mapFilePath,
  MapRecordNotFoundError,
  readMapRecord,
  writeMapRecord,
} from "../../src/map/record-io.ts";
import { MapRecord } from "../../src/map/schemas/index.ts";

function mkRepoRoot(): string {
  return mkdtempSync(join(tmpdir(), "prx-map-io-"));
}

function fixtureRecord(): MapRecord {
  return MapRecord.parse({
    name: "delegate-unblock",
    created: "2026-05-18",
    rationale: "GH-2011 gates verification of 2012/1979.",
    parents: ["GH-1500", "GH-1870"],
    sequence: [
      { id: "GH-2011", role: "gate", priority: "P0" },
      { id: "GH-2012", role: "implementation", depends: ["GH-2011"] },
      { id: "GH-2010", role: "fold-in", relates: ["GH-2011"] },
    ],
  });
}

describe("writeMapRecord + readMapRecord", () => {
  test("round-trips a record through .prx/maps/<name>.json", () => {
    const repoRoot = mkRepoRoot();
    const original = fixtureRecord();

    const path = writeMapRecord(repoRoot, original);
    expect(path).toBe(mapFilePath(repoRoot, "delegate-unblock"));
    expect(existsSync(path)).toBe(true);

    const round = readMapRecord(repoRoot, "delegate-unblock");
    expect(round).toEqual(original);
  });

  test("writes atomically — no .tmp.* siblings linger on success", () => {
    const repoRoot = mkRepoRoot();
    writeMapRecord(repoRoot, fixtureRecord());

    const entries = readdirSync(join(repoRoot, ".prx", "maps"));
    expect(entries).toEqual(["delegate-unblock.json"]);
    expect(entries.every((e) => !e.startsWith(".tmp"))).toBe(true);
  });

  test("re-write overwrites in place (single file, latest content)", () => {
    const repoRoot = mkRepoRoot();
    const v1 = fixtureRecord();
    writeMapRecord(repoRoot, v1);

    const v2: MapRecord = { ...v1, rationale: "updated rationale" };
    writeMapRecord(repoRoot, v2);

    const entries = readdirSync(join(repoRoot, ".prx", "maps"));
    expect(entries).toEqual(["delegate-unblock.json"]);

    const onDisk = JSON.parse(
      readFileSync(mapFilePath(repoRoot, "delegate-unblock"), "utf8"),
    );
    expect(onDisk.rationale).toBe("updated rationale");
  });

  test("readMapRecord throws MapRecordNotFoundError when absent", () => {
    const repoRoot = mkRepoRoot();
    expect(() => readMapRecord(repoRoot, "missing")).toThrow(MapRecordNotFoundError);
  });
});

describe("listMapNames", () => {
  test("returns [] when .prx/maps/ does not exist", () => {
    const repoRoot = mkRepoRoot();
    expect(listMapNames(repoRoot)).toEqual([]);
  });

  test("lists sorted names and skips hidden + non-.json files", () => {
    const repoRoot = mkRepoRoot();
    writeMapRecord(repoRoot, { ...fixtureRecord(), name: "zeta-track" });
    writeMapRecord(repoRoot, { ...fixtureRecord(), name: "alpha-track" });

    expect(listMapNames(repoRoot)).toEqual(["alpha-track", "zeta-track"]);
  });
});
