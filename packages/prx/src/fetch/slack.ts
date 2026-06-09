// prx fetch slack (prx-agd) — freshness (watermark) + CAS persistence over the
// slack read.
//
// The split the user articulated: scout = the read (already content-addressed +
// slack.read/v1 provenanced); fetch = the freshness loop that persists new
// messages to CAS, deduping by content digest and advancing a monotonic
// watermark on Slack `ts`. This is the pure core (read + store injected); the
// CLI verb, the slack-surface read adapter, and rate-limit/budget gating are
// follow-on slices, mirroring `fetch gh-issues`.

import { sha256Hex, type BlobStore, type Digest } from "@bounded-systems/cas";
import { canonicalJson } from "@bounded-systems/slack";

export interface SlackFetchInput {
  channel: string;
  /** Last-synced Slack ts; only messages strictly newer are persisted. */
  watermark?: string | undefined;
  /** Page size for the underlying read (default 100). */
  limit?: number | undefined;
}

/** A Slack message — only `ts` is load-bearing; the rest is addressed opaquely. */
export interface SlackMessage {
  ts: string;
  [k: string]: unknown;
}

export interface SlackFetchDeps {
  /** Read channel history at/after `oldest` (the slack surface in prod). */
  readHistory: (args: {
    channel: string;
    oldest?: string | undefined;
    limit: number;
  }) => Promise<{ messages: SlackMessage[] }>;
  /** CAS port — content-addresses each message; `has` gives free dedup. */
  store: Pick<BlobStore, "put" | "has">;
}

export interface SlackFetchResult {
  channel: string;
  /** Messages strictly newer than the prior watermark, in ts order. */
  fetched: number;
  /** Of those, how many were already in CAS (deduped, not re-stored). */
  deduped: number;
  /** Content address of each fetched message (ts order). */
  digests: Digest[];
  /** New monotonic watermark = max(ts) over the fetch, else the prior one. */
  watermark: string | undefined;
}

const DEFAULT_LIMIT = 100;
const enc = new TextEncoder();

/** Stable bytes for a message — channel-scoped + canonical (key-order-stable). */
function messageBytes(channel: string, message: SlackMessage): Uint8Array {
  return enc.encode(canonicalJson({ channel, message }));
}

/**
 * Fetch a channel's new messages: read since the watermark, keep only those
 * strictly newer (conversations.history `oldest` is inclusive, so we re-filter
 * the boundary), content-address each, persist the unseen ones to CAS, and
 * advance the watermark to max(ts). Idempotent: a re-run over the same data
 * stores nothing new (every message dedupes on its digest).
 */
export async function runFetchSlack(
  input: SlackFetchInput,
  deps: SlackFetchDeps,
): Promise<SlackFetchResult> {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const { messages } = await deps.readHistory({
    channel: input.channel,
    oldest: input.watermark,
    limit,
  });

  const fresh = messages
    .filter((m) => input.watermark === undefined || m.ts > input.watermark)
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  const digests: Digest[] = [];
  let deduped = 0;
  for (const m of fresh) {
    const bytes = messageBytes(input.channel, m);
    const digest = sha256Hex(bytes);
    digests.push(digest);
    if (await deps.store.has(digest)) {
      deduped += 1;
      continue;
    }
    await deps.store.put(bytes);
  }

  const watermark = fresh.length > 0 ? fresh[fresh.length - 1]!.ts : input.watermark;
  return { channel: input.channel, fetched: fresh.length, deduped, digests, watermark };
}
