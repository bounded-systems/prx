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
  const readHistory = async (args: { channel: string; oldest?: string | undefined; limit: number }) => {
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

  test("empty fetch leaves the watermark unchanged", async () => {
    const { store } = memStore();
    const { readHistory } = reader([]);
    const r = await runFetchSlack({ channel: "C1", watermark: "100.3" }, { readHistory, store });
    expect(r.fetched).toBe(0);
    expect(r.watermark).toBe("100.3");
  });
});
