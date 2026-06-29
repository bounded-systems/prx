// prx-agd — per-channel watermark for `prx fetch slack <channel>`.
//
// Mirrors `watermark.ts` (the gh-issues fetch watermark) but keyed per
// channel, because a Slack sync advances independently per conversation:
// `prx.fetch.slack.<channel>.watermark` holds the last-synced Slack `ts`.
// Same substrate decision as gh-issues — bd owns the store, so the value
// lives in `bd config` (clone-survival + SQL/CLI queryability + bd's
// concurrency model) rather than a parallel state file.
//
// Reuses the `watermark.ts` spawn seam (`defaultSpawnRunner`, `SpawnRunner`,
// `WatermarkDeps`) and `WatermarkError` verbatim; only the key derivation and
// the channel-scoped wrappers are new. The gh-issues watermark functions are
// untouched.

import { WatermarkError, type WatermarkDeps } from "./watermark.ts";
import { containerRepoRunner } from "../beads/container-runner.ts";

// Channel ids are Slack's `C…`/`G…`/`D…` opaque ids (uppercase alphanumerics).
// Constrain the segment that lands in the bd-config dotted key so a malformed
// channel can't smuggle key separators (`.`) or shell-hostile characters into
// `bd config set`.
const CHANNEL_RE = /^[A-Za-z0-9_-]+$/;

/** `bd config` key holding the last-synced Slack `ts` for one channel. */
export function slackWatermarkKey(channel: string): string {
  if (typeof channel !== "string" || !CHANNEL_RE.test(channel)) {
    throw new WatermarkError(
      `invalid slack channel id: ${String(channel)} (must match ${CHANNEL_RE.source})`,
      "INVALID_CHANNEL",
    );
  }
  return `prx.fetch.slack.${channel}.watermark`;
}

/**
 * Read `prx.fetch.slack.<channel>.watermark` from `bd config`. Returns
 * `{ ts: null }` when the key is absent. Coerces both bd "absent" modes to
 * `null` (exit-0 `"<key> (not set)"` on stdout; legacy exit-1 `not set` on
 * stderr), exactly as `getWatermark` does. Throws `WatermarkError` only when
 * the spawn fails for another reason (e.g. bd binary missing).
 */
export function getSlackWatermark(channel: string, deps: WatermarkDeps): { ts: string | null } {
  const key = slackWatermarkKey(channel);
  // prx-82b 2e.2: bd config get/set runs in an ephemeral container, not host bd.
  const runner = deps.runner ?? containerRepoRunner();
  const result = runner(["bd", "config", "get", key], { cwd: deps.cwd });
  if (result.status === 0) {
    const trimmed = result.stdout.trim();
    if (trimmed.length === 0) return { ts: null };
    if (trimmed.toLowerCase().includes("(not set)")) return { ts: null };
    return { ts: trimmed };
  }
  const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (combined.includes("not set") || combined.includes("not found")) {
    return { ts: null };
  }
  throw new WatermarkError(
    `bd config get ${key} failed (exit ${result.status}): ${result.stderr.trim()}`,
    "WATERMARK_READ_FAILED",
  );
}

/**
 * Write `prx.fetch.slack.<channel>.watermark` to `bd config`. Called after a
 * successful fetch advances the channel's watermark to `max(ts)`.
 */
export function setSlackWatermark(channel: string, ts: string, deps: WatermarkDeps): void {
  const key = slackWatermarkKey(channel);
  // prx-82b 2e.2: bd config get/set runs in an ephemeral container, not host bd.
  const runner = deps.runner ?? containerRepoRunner();
  const result = runner(["bd", "config", "set", key, ts], { cwd: deps.cwd });
  if (result.status !== 0) {
    throw new WatermarkError(
      `bd config set ${key} failed (exit ${result.status}): ${result.stderr.trim()}`,
      "WATERMARK_WRITE_FAILED",
    );
  }
}
