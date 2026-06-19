// prx fetch slack (prx-agd) — the freshness + CAS core. Fakes for the read and
// the CAS store; no real Slack, no monolith.
import { describe, expect, test } from "bun:test";

import { sha256Hex, type Digest } from "@bounded-systems/cas";

import { runFetchSlack, type SlackMessage } from "../../src/fetch/slack.ts";

function memStore() {
  const blobs = new Map<string, Uint8Array>();
  const store = {
    async put(bytes: Uint8Array): Promise<Digest> {
      const d = sha256Hex(bytes);
      blobs.set(d as string, bytes);
      return d;
    },
    async has(d: Digest): Promise<boolean> {
      return blobs.has(d as string);
    },
  };
  return { blobs, store };
}

function reader(messages: SlackMessage[]) {
  const seen: { oldest?: string | undefined } = {};
  const readHistory = async (args: {
    channel: string;
    oldest?: string | undefined;
    limit: number;
  }) => {
    seen.oldest = args.oldest;
    return { messages };
  };
  return { readHistory, seen };
}

const MSGS: SlackMessage[] = [
  { ts: "100.1", text: "a" },
  { ts: "100.3", text: "c" },
  { ts: "100.2", text: "b" },
];

describe("runFetchSlack — freshness + CAS", () => {
  test("first sync: stores all, advances watermark to max(ts)", async () => {
    const { blobs, store } = memStore();
    const { readHistory } = reader(MSGS);
    const r = await runFetchSlack({ channel: "C1" }, { readHistory, store });
    expect(r.fetched).toBe(3);
    expect(r.deduped).toBe(0);
    expect(r.watermark).toBe("100.3"); // max ts, regardless of input order
    expect(blobs.size).toBe(3);
    expect(r.digests).toHaveLength(3);
  });

  test("watermark passed to the read as `oldest`, and only strictly-newer kept", async () => {
    const { store } = memStore();
    const { readHistory, seen } = reader(MSGS);
    // oldest is inclusive at Slack; the boundary message (ts == watermark) must
    // not be re-counted.
    const r = await runFetchSlack({ channel: "C1", watermark: "100.2" }, { readHistory, store });
    expect(seen.oldest).toBe("100.2");
    expect(r.fetched).toBe(1); // only 100.3
    expect(r.watermark).toBe("100.3");
  });

  test("idempotent: a second identical run stores nothing new (CAS dedup)", async () => {
    const { blobs, store } = memStore();
    const { readHistory } = reader(MSGS);
    await runFetchSlack({ channel: "C1" }, { readHistory, store });
    const again = await runFetchSlack({ channel: "C1" }, { readHistory, store });
    expect(again.fetched).toBe(3);
    expect(again.deduped).toBe(3); // all already present
    expect(blobs.size).toBe(3); // nothing re-stored
  });

  test("same ts in a different channel addresses distinctly (channel-scoped)", async () => {
    const { blobs, store } = memStore();
    await runFetchSlack({ channel: "C1" }, { readHistory: reader(MSGS).readHistory, store });
    await runFetchSlack({ channel: "C2" }, { readHistory: reader(MSGS).readHistory, store });
    expect(blobs.size).toBe(6); // no cross-channel collision
  });

  test("metadata churn (reactions/replies) dedups — content digest is unchanged (prx-psj)", async () => {
    const { blobs, store } = memStore();
    await runFetchSlack({ channel: "C1" }, { readHistory: reader(MSGS).readHistory, store });
    expect(blobs.size).toBe(3);
    // same messages, now with reactions + a grown reply_count: content unchanged.
    const withChurn = MSGS.map((m) => ({
      ...m,
      reactions: [{ name: "+1", count: 2 }],
      reply_count: 5,
      latest_reply: "200.0",
    }));
    const again = await runFetchSlack(
      { channel: "C1" },
      { readHistory: reader(withChurn).readHistory, store },
    );
    expect(again.deduped).toBe(3); // all dedup on content
    expect(blobs.size).toBe(3); // nothing re-stored despite the metadata churn
  });

  test("empty fetch leaves the watermark unchanged", async () => {
    const { store } = memStore();
    const { readHistory } = reader([]);
    const r = await runFetchSlack({ channel: "C1", watermark: "100.3" }, { readHistory, store });
    expect(r.fetched).toBe(0);
    expect(r.watermark).toBe("100.3");
    expect(r.pages).toBe(1);
  });
});

// A reader that hands back one page per call, attaching the next cursor until
// the supplied pages are drained. Records every (oldest, cursor) it saw.
function pagingReader(pages: SlackMessage[][]) {
  const calls: Array<{ oldest?: string | undefined; cursor?: string | undefined }> = [];
  let i = 0;
  const readHistory = async (args: {
    channel: string;
    oldest?: string | undefined;
    cursor?: string | undefined;
    limit: number;
  }) => {
    calls.push({ oldest: args.oldest, cursor: args.cursor });
    const messages = pages[i] ?? [];
    const hasNext = i < pages.length - 1;
    i += 1;
    return { messages, ...(hasNext ? { cursor: `cur-${i}` } : {}) };
  };
  return { readHistory, calls };
}

describe("runFetchSlack — cursor pagination (prx-13x)", () => {
  test("drains every page, collecting all messages across the channel delta", async () => {
    const { blobs, store } = memStore();
    const { readHistory, calls } = pagingReader([
      [{ ts: "100.1" }, { ts: "100.2" }],
      [{ ts: "100.3" }, { ts: "100.4" }],
      [{ ts: "100.5" }],
    ]);
    const r = await runFetchSlack({ channel: "C1", limit: 2 }, { readHistory, store });
    expect(r.pages).toBe(3);
    expect(r.fetched).toBe(5);
    expect(blobs.size).toBe(5);
    expect(r.watermark).toBe("100.5"); // global max across all pages
    // oldest is undefined (cold start) on every page; the cursor advances.
    expect(calls.map((c) => c.cursor)).toEqual([undefined, "cur-1", "cur-2"]);
  });

  test("maxPages bounds the drain (resumes next run from the advanced watermark)", async () => {
    const { store } = memStore();
    const { readHistory, calls } = pagingReader([
      [{ ts: "1.1" }],
      [{ ts: "1.2" }],
      [{ ts: "1.3" }],
    ]);
    const r = await runFetchSlack({ channel: "C1", limit: 1, maxPages: 2 }, { readHistory, store });
    expect(r.pages).toBe(2);
    expect(calls).toHaveLength(2); // stopped before the 3rd page
    expect(r.fetched).toBe(2);
    expect(r.watermark).toBe("1.2");
  });

  test("a stuck cursor (never advances) cannot loop forever", async () => {
    const { store } = memStore();
    let n = 0;
    const readHistory = async () => {
      n += 1;
      return { messages: [{ ts: `9.${n}` }], cursor: "STUCK" }; // same cursor every page
    };
    const r = await runFetchSlack({ channel: "C1", maxPages: 50 }, { readHistory, store });
    // first page accepted, second sees the repeat and breaks → 2 reads, not 50.
    expect(r.pages).toBe(2);
  });

  test("strictly-newer filter spans pages; the boundary message is not re-counted", async () => {
    const { store } = memStore();
    const { readHistory } = pagingReader([
      [{ ts: "5.0" }, { ts: "5.1" }], // 5.0 == watermark (inclusive boundary)
      [{ ts: "5.2" }],
    ]);
    const r = await runFetchSlack({ channel: "C1", watermark: "5.0" }, { readHistory, store });
    expect(r.fetched).toBe(2); // 5.1 + 5.2, not 5.0
    expect(r.watermark).toBe("5.2");
  });
});
