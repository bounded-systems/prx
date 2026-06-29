// prx-agd — `prx fetch slack` composition root. Fakes all three seams (read
// adapter, CAS store, bd-config watermark); no real Slack / CAS / bd. Asserts
// the watermark→oldest→advance wiring around the already-tested pure core.
import { describe, expect, test } from "bun:test";

import { sha256Hex, type Digest } from "@bounded-systems/cas";

import { runFetchSlackSync } from "../../src/fetch/slack-sync.ts";
import type { SlackMessage } from "../../src/fetch/slack.ts";

function memStore() {
  const blobs = new Map<string, Uint8Array>();
  return {
    blobs,
    store: {
      async put(bytes: Uint8Array): Promise<Digest> {
        const d = sha256Hex(bytes);
        blobs.set(d as string, bytes);
        return d;
      },
      async has(d: Digest): Promise<boolean> {
        return blobs.has(d as string);
      },
    },
  };
}

function reader(messages: SlackMessage[]) {
  const seen: { oldest?: string | undefined; limit?: number | undefined } = {};
  const readHistory = async (args: {
    channel: string;
    oldest?: string | undefined;
    limit: number;
  }) => {
    seen.oldest = args.oldest;
    seen.limit = args.limit;
    return { messages };
  };
  return { readHistory, seen };
}

// Fake bd-config seam: `get` returns the seeded watermark (or "(not set)");
// `set` is recorded.
// prx-82b 2e.2: the slack cursor is a host-local file now. Seed `initial` at the
// per-channel path; capture writes. `sets` records the written value(s).
const HOME = "/home/test";
const wmEnv = ((k: string) => (k === "HOME" ? HOME : undefined)) as never;
const slackPath = (channel: string) =>
  `${HOME}/.local/state/prx/sync/slack/_repo/${channel}/watermark`;

function watermark(initial: string | null, channel = "C1") {
  const files = new Map<string, string>();
  if (initial !== null) files.set(slackPath(channel), initial);
  const sets: Array<{ value: string }> = [];
  const watermarkFs = {
    env: wmEnv,
    readFile: (p: string): string => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    writeFile: (p: string, data: string): void => {
      files.set(p, data);
      sets.push({ value: data });
    },
  };
  return { watermarkFs, sets };
}

const MSGS: SlackMessage[] = [
  { ts: "100.1", text: "a" },
  { ts: "100.3", text: "c" },
  { ts: "100.2", text: "b" },
];

describe("runFetchSlackSync — watermark wiring", () => {
  test("cold start: no watermark → fetch all, advance to max(ts)", async () => {
    const { blobs, store } = memStore();
    const { readHistory, seen } = reader(MSGS);
    const { watermarkFs, sets } = watermark(null);

    const r = await runFetchSlackSync(
      { channel: "C1" },
      { cwd: "/repo", readHistory, store, watermarkFs },
    );

    expect(seen.oldest).toBeUndefined(); // cold start passes no oldest
    expect(r.fetched).toBe(3);
    expect(r.deduped).toBe(0);
    expect(r.watermark).toEqual({ from: null, to: "100.3", advanced: true });
    expect(blobs.size).toBe(3);
    expect(sets).toEqual([{ value: "100.3" }]);
  });

  test("warm: prior watermark passed as oldest; advance to new max", async () => {
    const { store } = memStore();
    const { readHistory, seen } = reader(MSGS);
    const { watermarkFs, sets } = watermark("100.2");

    const r = await runFetchSlackSync(
      { channel: "C1", limit: 50 },
      { cwd: "/repo", readHistory, store, watermarkFs },
    );

    expect(seen.oldest).toBe("100.2"); // watermark threaded to the read
    expect(seen.limit).toBe(50);
    expect(r.fetched).toBe(1); // only 100.3 is strictly newer
    expect(r.watermark).toEqual({ from: "100.2", to: "100.3", advanced: true });
    expect(sets).toEqual([{ value: "100.3" }]);
  });

  test("empty fetch: no advance, no watermark write", async () => {
    const { store } = memStore();
    const { readHistory } = reader([]);
    const { watermarkFs, sets } = watermark("100.3");

    const r = await runFetchSlackSync(
      { channel: "C1" },
      { cwd: "/repo", readHistory, store, watermarkFs },
    );

    expect(r.fetched).toBe(0);
    expect(r.watermark).toEqual({ from: "100.3", to: "100.3", advanced: false });
    expect(sets).toEqual([]); // monotonic: nothing to persist
  });

  test("an unreadable cursor self-heals to a cold start (no error; prx-82b 2e.2)", async () => {
    const { blobs, store } = memStore();
    const { readHistory, seen } = reader(MSGS);
    // A read that throws (corrupt/unreadable cursor) ⇒ treated as absent ⇒ cold start.
    const watermarkFs = {
      env: wmEnv,
      readFile: (): string => {
        throw new Error("EACCES");
      },
      writeFile: () => {},
    };

    const r = await runFetchSlackSync(
      { channel: "C1" },
      { cwd: "/repo", readHistory, store, watermarkFs },
    );

    expect(seen.oldest).toBeUndefined(); // self-healed to a full fetch
    expect(r.fetched).toBe(3);
    expect(blobs.size).toBe(3);
  });

  test("drains pages then advances once to the global max (prx-13x)", async () => {
    const { blobs, store } = memStore();
    const { watermarkFs, sets } = watermark(null);
    // Paginating reader: two pages, then drained.
    let i = 0;
    const pages: SlackMessage[][] = [[{ ts: "1.1" }, { ts: "1.2" }], [{ ts: "1.3" }]];
    const readHistory = async () => {
      const messages = pages[i] ?? [];
      const hasNext = i < pages.length - 1;
      i += 1;
      return { messages, ...(hasNext ? { cursor: `c${i}` } : {}) };
    };

    const r = await runFetchSlackSync(
      { channel: "C1" },
      { cwd: "/repo", readHistory, store, watermarkFs },
    );

    expect(r.pages).toBe(2);
    expect(r.fetched).toBe(3);
    expect(blobs.size).toBe(3);
    // watermark persisted exactly once, to the global max across pages.
    expect(sets).toEqual([{ value: "1.3" }]);
  });

  test("forwards maxPages to the core to bound the drain", async () => {
    const { store } = memStore();
    const { watermarkFs } = watermark(null);
    let calls = 0;
    const readHistory = async () => {
      calls += 1;
      return { messages: [{ ts: `2.${calls}` }], cursor: `more-${calls}` }; // always more, advancing
    };

    const r = await runFetchSlackSync(
      { channel: "C1", maxPages: 3 },
      { cwd: "/repo", readHistory, store, watermarkFs },
    );

    expect(r.pages).toBe(3);
    expect(calls).toBe(3);
  });
});
