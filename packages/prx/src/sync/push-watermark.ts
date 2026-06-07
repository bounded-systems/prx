// GH-296 / prx-lzw — per-(repo,domain) "last successfully pushed bead HEAD"
// watermark, persisted under ~/.local/state/prx/sync/<key>/push-head.
//
// The sync push leg reads this to decide whether the bead store moved since the
// last SUCCESSFUL push (see push-freshness-gate). File-backed + injectable so
// the run loop's IO stays testable.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { getEnv } from "@bounded-systems/env";

export type PushWatermark = {
  /** The last successfully-pushed bead HEAD for this key, or undefined if none. */
  read(): string | undefined;
  /** Record `head` as the last successfully-pushed HEAD. */
  write(head: string): void;
};

export type CreatePushWatermarkDeps = {
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

/** The watermark file path for a key under `home`. Exported for tests. */
export function pushWatermarkPath(repoKey: string, home: string): string {
  return `${home}/.local/state/prx/sync/${safeKey(repoKey)}/push-head`;
}

export function createPushWatermark(
  repoKey: string,
  deps: CreatePushWatermarkDeps = {},
): PushWatermark {
  const env = deps.env ?? getEnv;
  const home = env("HOME") ?? "";
  const path = pushWatermarkPath(repoKey, home);
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
  return {
    read(): string | undefined {
      if (home.length === 0) return undefined; // no HOME ⇒ no persistence
      const v = readFile(path)?.trim();
      return v && v.length > 0 ? v : undefined;
    },
    write(head: string): void {
      if (home.length === 0) return;
      writeFile(path, `${head}\n`);
    },
  };
}
