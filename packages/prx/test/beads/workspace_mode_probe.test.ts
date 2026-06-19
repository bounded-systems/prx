// beads/workspace_mode — probeSharedServerHasIssues (the GH-1700 liveness probe,
// driven through its injectable spawn seam) + readBeadsMetadata's parse arms.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { probeSharedServerHasIssues, readBeadsMetadata } from "../../src/beads/workspace_mode.ts";
import type { SpawnCaptureFn } from "@bounded-systems/proc";

const cap = (stdout: string, status = 0): ReturnType<SpawnCaptureFn> => ({
  status,
  signal: null,
  stdout,
  stderr: "",
});
const spawnReturning = (stdout: string, status = 0): SpawnCaptureFn =>
  (() => cap(stdout, status)) as SpawnCaptureFn;

describe("probeSharedServerHasIssues", () => {
  test("a spawn failure reads as no issues", () => {
    expect(probeSharedServerHasIssues("/x", { spawn: spawnReturning("", 1) })).toBe(false);
  });
  test("empty stdout reads as no issues", () => {
    expect(probeSharedServerHasIssues("/x", { spawn: spawnReturning("   ") })).toBe(false);
  });
  test("a non-empty JSON array → true", () => {
    expect(probeSharedServerHasIssues("/x", { spawn: spawnReturning('[{"id":1}]') })).toBe(true);
  });
  test("an empty JSON array → false", () => {
    expect(probeSharedServerHasIssues("/x", { spawn: spawnReturning("[]") })).toBe(false);
  });
  test("an { issues: [...] } envelope → true", () => {
    expect(
      probeSharedServerHasIssues("/x", { spawn: spawnReturning('{"issues":[{"id":1}]}') }),
    ).toBe(true);
  });
  test("an { items: [...] } envelope → true", () => {
    expect(
      probeSharedServerHasIssues("/x", { spawn: spawnReturning('{"items":[{"id":1}]}') }),
    ).toBe(true);
  });
  test("an object with neither issues nor items → false", () => {
    expect(probeSharedServerHasIssues("/x", { spawn: spawnReturning('{"other":true}') })).toBe(
      false,
    );
  });
  test("unparseable stdout reads as no issues", () => {
    expect(probeSharedServerHasIssues("/x", { spawn: spawnReturning("{not json") })).toBe(false);
  });
});

describe("readBeadsMetadata", () => {
  function beadsDir(metadata?: string): string {
    const dir = mkdtempSync(join(tmpdir(), "ws-meta-"));
    if (metadata !== undefined) writeFileSync(join(dir, "metadata.json"), metadata);
    return dir;
  }

  test("returns nulls when metadata.json is absent", () => {
    expect(readBeadsMetadata(beadsDir())).toEqual({ dolt_mode: null, dolt_database: null });
  });
  test("reads dolt_mode + dolt_database from valid metadata", () => {
    const dir = beadsDir(JSON.stringify({ dolt_mode: "shared_server", dolt_database: "io_x" }));
    expect(readBeadsMetadata(dir)).toEqual({ dolt_mode: "shared_server", dolt_database: "io_x" });
  });
  test("non-string fields collapse to null", () => {
    const dir = beadsDir(JSON.stringify({ dolt_mode: 42, dolt_database: "" }));
    expect(readBeadsMetadata(dir)).toEqual({ dolt_mode: null, dolt_database: null });
  });
  test("malformed JSON is swallowed → nulls", () => {
    const dir = beadsDir("{ not valid json");
    expect(readBeadsMetadata(dir)).toEqual({ dolt_mode: null, dolt_database: null });
  });
});
