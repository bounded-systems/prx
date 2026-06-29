// prx-agd — per-channel fetch cursor for `prx fetch slack <channel>` (prx-82b 2e.2).
//
// Mirrors `watermark.ts` (the gh-issues fetch cursor) but keyed per channel,
// because a Slack sync advances independently per conversation. Same model: a
// LOCAL-FIRST, self-healing optimization cursor (the last-synced Slack `ts`)
// stored host-local under `~/.local/state/prx/sync/slack/<repo>/<channel>/`, NOT
// in `bd config` (prx-82b removed the host-bd dependency). A missing cursor just
// re-syncs from the start — never wrong. Reuses `WatermarkDeps` + `WatermarkError`.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { getEnv } from "@bounded-systems/env";

import { WatermarkError, type WatermarkDeps } from "./watermark.ts";

// Channel ids are Slack's `C…`/`G…`/`D…` opaque ids. Constrain the segment that
// lands in the on-disk path so a malformed channel can't smuggle path separators.
const CHANNEL_RE = /^[A-Za-z0-9_-]+$/;

function safeKey(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Logical cursor id for a channel (kept stable for logs; validates the channel). */
export function slackWatermarkKey(channel: string): string {
  if (typeof channel !== "string" || !CHANNEL_RE.test(channel)) {
    throw new WatermarkError(
      `invalid slack channel id: ${String(channel)} (must match ${CHANNEL_RE.source})`,
      "INVALID_CHANNEL",
    );
  }
  return `prx.fetch.slack.${channel}.watermark`;
}

/** The host-local cursor file for a (repo cwd, channel), or `null` if `$HOME` unset. */
function slackCursorPath(cwd: string, channel: string, env: typeof getEnv): string | null {
  const home = env("HOME");
  if (typeof home !== "string" || home.length === 0) return null;
  return `${home}/.local/state/prx/sync/slack/${safeKey(cwd)}/${channel}/watermark`;
}

/** The last-synced Slack `ts` for one channel, or `{ ts: null }` if unset (⇒ full re-sync). */
export function getSlackWatermark(channel: string, deps: WatermarkDeps): { ts: string | null } {
  slackWatermarkKey(channel); // validate
  const env = deps.env ?? getEnv;
  const path = slackCursorPath(deps.cwd, channel, env);
  if (path === null) return { ts: null };
  const read = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  try {
    const value = read(path).trim();
    return { ts: value.length > 0 ? value : null };
  } catch {
    return { ts: null }; // absent ⇒ null ⇒ full re-sync (self-healing)
  }
}

/** Advance a channel's fetch cursor. Best-effort (a lost write self-heals). */
export function setSlackWatermark(channel: string, ts: string, deps: WatermarkDeps): void {
  slackWatermarkKey(channel); // validate
  const env = deps.env ?? getEnv;
  const path = slackCursorPath(deps.cwd, channel, env);
  if (path === null) return;
  const write =
    deps.writeFile ??
    ((p: string, data: string) => {
      mkdirSync(p.replace(/\/[^/]+$/, ""), { recursive: true });
      writeFileSync(p, data);
    });
  try {
    write(path, ts);
  } catch {
    // Best-effort: a lost cursor write self-heals on the next sync.
  }
}
