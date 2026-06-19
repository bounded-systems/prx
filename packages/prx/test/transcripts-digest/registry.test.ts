// GH-1495 — transcript source-adapter registry. The adapters' discover() is a
// lazy async generator, so the kind-guard + delegation are testable without
// touching the filesystem (we never iterate).

import { describe, expect, test } from "bun:test";

import {
  getAdapter,
  knownTranscriptSources,
  listAdapters,
} from "../../src/transcripts-digest/sources/registry.ts";
import type {
  TranscriptSourceConfig,
  TranscriptSourceKind,
} from "../../src/transcripts-digest/schemas.ts";

const config = (kind: string) => ({ kind }) as TranscriptSourceConfig;

describe("transcript source registry", () => {
  test("getAdapter returns the adapter for each known kind", () => {
    for (const kind of knownTranscriptSources) {
      expect(getAdapter(kind).kind).toBe(kind);
    }
  });

  test("getAdapter throws on an unknown source kind", () => {
    expect(() => getAdapter("codex" as TranscriptSourceKind)).toThrow(/unknown transcript source/);
  });

  test("listAdapters returns every registered adapter", () => {
    expect(
      listAdapters()
        .map((a) => a.kind)
        .sort(),
    ).toEqual([...knownTranscriptSources].sort());
  });

  test("knownTranscriptSources lists both shipping adapters", () => {
    expect([...knownTranscriptSources].sort()).toEqual(["claude-code-jsonl", "claude-web-export"]);
  });

  test("discover delegates (lazily) for a matching config kind", () => {
    for (const kind of knownTranscriptSources) {
      const iter = getAdapter(kind).discover(config(kind), {});
      expect(typeof (iter as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe("function");
    }
  });

  test("discover rejects a config whose kind mismatches the adapter", () => {
    expect(() => getAdapter("claude-code-jsonl").discover(config("claude-web-export"), {})).toThrow(
      /received config kind=claude-web-export/,
    );
    expect(() => getAdapter("claude-web-export").discover(config("claude-code-jsonl"), {})).toThrow(
      /received config kind=claude-code-jsonl/,
    );
  });
});
