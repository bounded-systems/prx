import { describe, expect, test } from "bun:test";

import {
  DepManifest,
  DepManifestEntry,
  DepDelta,
  DepSnapshot,
} from "../../src/dep-research/schemas.ts";

const validEntry: unknown = {
  name: "xstate",
  source: {
    kind: "git",
    url: "https://github.com/statelyai/xstate",
    paths: ["packages/core/src/types.ts"],
  },
  classification_hints: {
    schema: ["types\\.ts$"],
    state: [],
    cli: [],
    config: [],
  },
};

describe("DepManifestEntry", () => {
  test("parses a minimal valid entry", () => {
    expect(() => DepManifestEntry.parse(validEntry)).not.toThrow();
  });

  test("rejects unknown source.kind", () => {
    const bad = {
      ...(validEntry as object),
      source: { kind: "ftp", url: "https://x", paths: ["a"] },
    };
    expect(() => DepManifestEntry.parse(bad)).toThrow();
  });

  test("rejects malformed url", () => {
    const bad = {
      ...(validEntry as object),
      source: { kind: "git", url: "not-a-url", paths: ["a"] },
    };
    expect(() => DepManifestEntry.parse(bad)).toThrow();
  });

  test("rejects empty paths", () => {
    const bad = {
      ...(validEntry as object),
      source: { kind: "git", url: "https://x.example/y", paths: [] },
    };
    expect(() => DepManifestEntry.parse(bad)).toThrow();
  });

  test("classification_hints defaults to empty arrays when omitted", () => {
    const minimal = {
      name: "z",
      source: { kind: "git", url: "https://x.example/y", paths: ["a"] },
    };
    const parsed = DepManifestEntry.parse(minimal);
    expect(parsed.classification_hints.schema).toEqual([]);
    expect(parsed.classification_hints.state).toEqual([]);
    expect(parsed.classification_hints.cli).toEqual([]);
    expect(parsed.classification_hints.config).toEqual([]);
  });
});

describe("DepManifest", () => {
  test("requires version=1 and at least one entry", () => {
    expect(() => DepManifest.parse({ version: 1, entries: [validEntry] })).not.toThrow();
    expect(() => DepManifest.parse({ version: 2, entries: [validEntry] })).toThrow();
    expect(() => DepManifest.parse({ version: 1, entries: [] })).toThrow();
  });
});

describe("DepSnapshot", () => {
  test("requires sha256-hex digests in source_sha256", () => {
    const ok = {
      dep: "x",
      run_id: "r1",
      fetched_at: "2026-05-02T00:00:00.000Z",
      source_sha256: { "a.ts": "a".repeat(64) },
      source_byte_len: { "a.ts": 12 },
    };
    expect(() => DepSnapshot.parse(ok)).not.toThrow();

    const badDigest = { ...ok, source_sha256: { "a.ts": "deadbeef" } };
    expect(() => DepSnapshot.parse(badDigest)).toThrow();
  });
});

describe("DepDelta", () => {
  test("classification=none and an empty changes list both round-trip", () => {
    const d = DepDelta.parse({
      dep: "x",
      prev_run_id: null,
      curr_run_id: "r1",
      classification: "none",
    });
    expect(d.changes).toEqual([]);
  });
});
