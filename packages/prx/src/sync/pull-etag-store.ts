// GH-296 / prx-lzw (lever 1) — per-(repo,domain) persisted ETag cache for the
// GH→bd pull leg's conditional reads. Maps an external issue id to the last
// `ETag` GitHub returned for it plus the last state we derived from that
// response (an opaque, adapter-owned JSON string). On the next tick the pull
// leg sends `If-None-Match: <etag>`; a `304` lets it reuse `value` for free.
//
// File-backed under ~/.local/state/prx/sync/<key>/pull-etags.json, alongside the
// push watermark. Loaded once into memory; `set` mutates in memory and `flush`
// writes the whole map back once (so a full pull tick is one file write, not N).
// IO is injectable so the run loop stays testable.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { getEnv } from "@bounded-systems/env";

/** A cached conditional-read entry for one external issue. */
export type PullEtagEntry = {
  /** The ETag GitHub last returned for this issue (sent back as If-None-Match). */
  etag: string;
  /** Adapter-owned opaque state derived from that response (reused on a 304). */
  value: string;
};

export type PullEtagStore = {
  /** The cached entry for `externalId`, or undefined if never fetched. */
  get(externalId: string): PullEtagEntry | undefined;
  /** Record the latest etag+state for `externalId` (in memory). */
  set(externalId: string, entry: PullEtagEntry): void;
  /** Persist the whole map once. No-op when there is no HOME to persist under. */
  flush(): void;
};

export type CreatePullEtagStoreDeps = {
  env?: typeof getEnv;
  /** Read a file's contents, or undefined when absent (default: fs, missing ⇒ undefined). */
  readFile?: ((path: string) => string | undefined) | undefined;
  /** Write a file (default: fs, creating parent dirs). */
  writeFile?: ((path: string, data: string) => void) | undefined;
};

/** Filesystem-safe key from a `(repo, domain)` pair. */
function safeKey(repoKey: string): string {
  return repoKey.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** The cache file path for a key under `home`. Exported for tests. */
export function pullEtagStorePath(repoKey: string, home: string): string {
  return `${home}/.local/state/prx/sync/${safeKey(repoKey)}/pull-etags.json`;
}

/** Parse a persisted map, tolerating absent/blank/corrupt files (⇒ empty). */
function parseStore(raw: string | undefined): Map<string, PullEtagEntry> {
  const map = new Map<string, PullEtagEntry>();
  if (raw === undefined || raw.trim().length === 0) return map;
  try {
    const obj = JSON.parse(raw) as unknown;
    if (obj && typeof obj === "object") {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (
          v &&
          typeof v === "object" &&
          typeof (v as PullEtagEntry).etag === "string" &&
          typeof (v as PullEtagEntry).value === "string"
        ) {
          map.set(k, { etag: (v as PullEtagEntry).etag, value: (v as PullEtagEntry).value });
        }
      }
    }
  } catch {
    // corrupt cache ⇒ start empty; a fresh fetch repopulates it.
  }
  return map;
}

export function createPullEtagStore(
  repoKey: string,
  deps: CreatePullEtagStoreDeps = {},
): PullEtagStore {
  const env = deps.env ?? getEnv;
  const home = env("HOME") ?? "";
  const path = pullEtagStorePath(repoKey, home);
  const readFile =
    deps.readFile ??
    ((p: string): string | undefined => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return undefined;
      }
    });
  const writeFile =
    deps.writeFile ??
    ((p: string, data: string): void => {
      mkdirSync(p.replace(/\/[^/]+$/, ""), { recursive: true });
      writeFileSync(p, data);
    });

  const map = home.length === 0 ? new Map<string, PullEtagEntry>() : parseStore(readFile(path));
  let dirty = false;

  return {
    get(externalId: string): PullEtagEntry | undefined {
      return map.get(externalId);
    },
    set(externalId: string, entry: PullEtagEntry): void {
      const prev = map.get(externalId);
      if (prev && prev.etag === entry.etag && prev.value === entry.value) return;
      map.set(externalId, entry);
      dirty = true;
    },
    flush(): void {
      if (home.length === 0 || !dirty) return; // no HOME ⇒ no persistence
      const obj: Record<string, PullEtagEntry> = {};
      for (const [k, v] of map) obj[k] = v;
      writeFile(path, `${JSON.stringify(obj, null, 2)}\n`);
      dirty = false;
    },
  };
}
