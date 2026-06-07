// GH-352: the cached layer between the async producer (`prx ci`, which has the
// ledger) and the SYNC reader (`prx snapshot`, ledger-free). The cache stores
// the verdict; freshness is recomputed at read time against the current commit.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  ciProvenanceCachePath,
  readCiProvenanceState,
  writeCiProvenanceCache,
} from "../../src/pr-state/ci-provenance-cache.ts";

const COMMIT = "1234567890abcdef1234567890abcdef12345678";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ci-prov-cache-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ci provenance cache — sync read with recomputed freshness (GH-352)", () => {
  test("fresh while the cached commit is still HEAD", () => {
    writeCiProvenanceCache(dir, { commit: COMMIT, verdict: "verified" });
    expect(readCiProvenanceState(dir, COMMIT)).toEqual({ verdict: "verified", freshness: "fresh" });
  });

  test("stale once HEAD has moved past the cached commit", () => {
    writeCiProvenanceCache(dir, { commit: COMMIT, verdict: "verified" });
    expect(readCiProvenanceState(dir, "f".repeat(40))).toEqual({
      verdict: "verified",
      freshness: "stale",
    });
  });

  test("verdict round-trips (unsigned stays unsigned)", () => {
    writeCiProvenanceCache(dir, { commit: COMMIT, verdict: "unsigned" });
    expect(readCiProvenanceState(dir, COMMIT)).toEqual({ verdict: "unsigned", freshness: "fresh" });
  });

  test("unknown freshness when the current commit can't be determined", () => {
    writeCiProvenanceCache(dir, { commit: COMMIT, verdict: "verified" });
    expect(readCiProvenanceState(dir, "")).toEqual({ verdict: "verified", freshness: "unknown" });
  });

  test("missing cache ⇒ unchecked/unknown default", () => {
    expect(readCiProvenanceState(dir, COMMIT)).toEqual({ verdict: "unchecked", freshness: "unknown" });
  });

  test("malformed cache ⇒ default (never throws)", () => {
    const path = ciProvenanceCachePath(dir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ not valid json", "utf8");
    expect(readCiProvenanceState(dir, COMMIT)).toEqual({ verdict: "unchecked", freshness: "unknown" });
  });
});
