// Source-adapter registry for `prx transcripts digest` (GH-1495).
//
// Each adapter implements `discover()` → an iterable of normalized
// `TranscriptSession` records. The XState machine reads from the registry
// once at resolve-time so adding a Codex / ChatGPT / Gemini adapter is a
// one-file change (new module + one registry entry) — the machine, the
// extractor, and the writers stay untouched.

import type { TranscriptSession, TranscriptSourceConfig } from "../schemas.ts";
import { TranscriptSourceKind } from "../schemas.ts";
import { discoverClaudeCodeJsonl } from "./claude-code-jsonl.ts";
import { discoverClaudeWebExport } from "./claude-web-export.ts";

export type DiscoverOptions = {
  /** Optional ISO-8601 lower bound on session startTs. */
  since?: string;
  /** Optional cap on the number of sessions yielded. */
  limit?: number;
};

export type TranscriptSourceAdapter = {
  kind: TranscriptSourceKind;
  discover: (
    config: TranscriptSourceConfig,
    opts: DiscoverOptions,
  ) => AsyncIterable<TranscriptSession>;
};

const adapters: Record<TranscriptSourceKind, TranscriptSourceAdapter> = {
  "claude-code-jsonl": {
    kind: "claude-code-jsonl",
    discover: (config, opts) => {
      if (config.kind !== "claude-code-jsonl") {
        throw new Error(`claude-code-jsonl adapter received config kind=${config.kind}`);
      }
      return discoverClaudeCodeJsonl(config, opts);
    },
  },
  "claude-web-export": {
    kind: "claude-web-export",
    discover: (config, opts) => {
      if (config.kind !== "claude-web-export") {
        throw new Error(`claude-web-export adapter received config kind=${config.kind}`);
      }
      return discoverClaudeWebExport(config, opts);
    },
  },
};

export function getAdapter(kind: TranscriptSourceKind): TranscriptSourceAdapter {
  const adapter = adapters[kind];
  if (!adapter) {
    throw new Error(`unknown transcript source: ${kind}`);
  }
  return adapter;
}

export function listAdapters(): TranscriptSourceAdapter[] {
  return Object.values(adapters);
}

export const knownTranscriptSources = Object.keys(adapters) as TranscriptSourceKind[];
