// prx fetch slack (prx-agd) — freshness (watermark) + CAS persistence over the
// slack read.
//
// The split the user articulated: scout = the read (already content-addressed +
// slack.read/v1 provenanced); fetch = the freshness loop that persists new
// messages to CAS, deduping by content digest and advancing a monotonic
// watermark on Slack `ts`. This is the pure core (read + store injected).
//
// prx-13x: pages the `conversations.history` cursor so a single run drains the
// whole delta (everything newer than the watermark), not just one page. The
// read adapter returns the page's `cursor`; the core loops until it drains
// (empty cursor), a `maxPages` bound is hit, or the cursor stops advancing.
// Rate-limit/budget gating remains a follow-on (blocked on slackd, prx-tgy) —
// Slack has no github-budget points bucket.

import { sha256Hex, type BlobStore, type Digest } from "@bounded-systems/cas";
import { canonicalJson } from "@bounded-systems/slack";

export interface SlackFetchInput {
  channel: string;
  /** Last-synced Slack ts; only messages strictly newer are persisted. */
  watermark?: string | undefined;
  /** Page size for each underlying read (default 100). */
  limit?: number | undefined;
  /**
   * Max history pages to drain in one run (cursor pagination). Defaults to
   * {@link DEFAULT_MAX_PAGES} — high enough to drain a channel's full delta,
   * bounded so a misbehaving cursor can't loop forever. Set to 1 for the old
   * single-page behaviour.
   */
  maxPages?: number | undefined;
}

/** A Slack message — only `ts` is load-bearing; the rest is addressed opaquely. */
export interface SlackMessage {
  ts: string;
  [k: string]: unknown;
}

export interface SlackFetchDeps {
  /**
   * Read one page of channel history at/after `oldest`, continuing from
   * `cursor` when paginating. Returns the page's messages and the next
   * `cursor` (absent/empty when the history is drained).
   */
  readHistory: (args: {
    channel: string;
    oldest?: string | undefined;
    cursor?: string | undefined;
    limit: number;
  }) => Promise<{ messages: SlackMessage[]; cursor?: string | undefined }>;
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
  /** History pages read this run (cursor pagination). */
  pages: number;
}

const DEFAULT_LIMIT = 100;
// Safety cap on the pagination loop: 1000 pages × the default limit ≈ 100k
// messages per run. Reached only by a channel with an enormous unseen delta or
// a misbehaving cursor; either way the next run resumes from the advanced
// watermark.
const DEFAULT_MAX_PAGES = 1000;
const enc = new TextEncoder();

/** Stable bytes for a message — channel-scoped + canonical (key-order-stable). */
function messageBytes(channel: string, message: SlackMessage): Uint8Array {
  return enc.encode(canonicalJson({ channel, message }));
}

/**
 * Fetch a channel's new messages: page `conversations.history` from the
 * watermark to the end of the delta (cursor pagination, bounded by
 * `maxPages`), keep only messages strictly newer than the watermark (`oldest`
 * is inclusive, so the boundary is re-filtered) deduped by `ts`, content-
 * address each, persist the unseen ones to CAS, and advance the watermark to
 * max(ts). Idempotent: a re-run over the same data stores nothing new (every
 * message dedupes on its digest) and the watermark never regresses.
 */
export async function runFetchSlack(
  input: SlackFetchInput,
  deps: SlackFetchDeps,
): Promise<SlackFetchResult> {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const maxPages = Math.max(1, input.maxPages ?? DEFAULT_MAX_PAGES);

  // Drain the cursor: page until Slack reports no next cursor, the page bound
  // is hit, or the cursor stops advancing (defensive — a stuck cursor must not
  // loop forever). `oldest` is passed on every page; the cursor carries the
  // rest of the pagination state.
  const collected: SlackMessage[] = [];
  let cursor: string | undefined = undefined;
  let pages = 0;
  const seenCursors = new Set<string>();
  while (pages < maxPages) {
    pages += 1;
    const page = await deps.readHistory({
      channel: input.channel,
      oldest: input.watermark,
      cursor,
      limit,
    });
    collected.push(...page.messages);
    const next = page.cursor;
    if (next === undefined || next.length === 0) break;
    if (seenCursors.has(next)) break;
    seenCursors.add(next);
    cursor = next;
  }

  // Strictly-newer than the watermark, deduped by ts (a paginated boundary or
  // an overlap can repeat a message), in ascending ts order.
  const byTs = new Map<string, SlackMessage>();
  for (const m of collected) {
    if (input.watermark === undefined || m.ts > input.watermark) {
      byTs.set(m.ts, m);
    }
  }
  const fresh = [...byTs.values()].sort((a, b) =>
    a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0,
  );

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
  return { channel: input.channel, fetched: fresh.length, deduped, digests, watermark, pages };
}
