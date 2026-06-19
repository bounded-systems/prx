// prx-agd — `prx fetch slack` composition root. Fakes all three seams (read
// adapter, CAS store, bd-config watermark); no real Slack / CAS / bd. Asserts
// the watermark→oldest→advance wiring around the already-tested pure core.
import { describe, expect, test } from "bun:test";

import { sha256Hex, type Digest } from "@bounded-systems/cas";

import { runFetchSlackSync, FetchSlackError } from "../../src/fetch/slack-sync.ts";
import type { SlackMessage } from "../../src/fetch/slack.ts";
import type { SpawnResult } from "../../src/fetch/watermark.ts";

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
function watermark(initial: string | null) {
  const sets: Array<{ key: string; value: string }> = [];
  const runner = (cmd: string[]): SpawnResult => {
    const [, , verb, key, value] = cmd;
    if (verb === "get") {
      return initial === null
        ? { stdout: `${key} (not set)`, stderr: "", status: 0 }
        : { stdout: `${initial}\n`, stderr: "", status: 0 };
    }
    if (verb === "set") {
      sets.push({ key: key!, value: value! });
      return { stdout: "", stderr: "", status: 0 };
    }
    return { stdout: "", stderr: "unexpected", status: 1 };
  };
  return { runner, sets };
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
    const { runner, sets } = watermark(null);

    const r = await runFetchSlackSync(
      { channel: "C1" },
      { cwd: "/repo", readHistory, store, watermarkRunner: runner },
    );

    expect(seen.oldest).toBeUndefined(); // cold start passes no oldest
    expect(r.fetched).toBe(3);
    expect(r.deduped).toBe(0);
    expect(r.watermark).toEqual({ from: null, to: "100.3", advanced: true });
    expect(blobs.size).toBe(3);
    expect(sets).toEqual([{ key: "prx.fetch.slack.C1.watermark", value: "100.3" }]);
  });

  test("warm: prior watermark passed as oldest; advance to new max", async () => {
    const { store } = memStore();
    const { readHistory, seen } = reader(MSGS);
    const { runner, sets } = watermark("100.2");

    const r = await runFetchSlackSync(
      { channel: "C1", limit: 50 },
      { cwd: "/repo", readHistory, store, watermarkRunner: runner },
    );

    expect(seen.oldest).toBe("100.2"); // watermark threaded to the read
    expect(seen.limit).toBe(50);
    expect(r.fetched).toBe(1); // only 100.3 is strictly newer
    expect(r.watermark).toEqual({ from: "100.2", to: "100.3", advanced: true });
    expect(sets).toEqual([{ key: "prx.fetch.slack.C1.watermark", value: "100.3" }]);
  });

  test("empty fetch: no advance, no watermark write", async () => {
    const { store } = memStore();
    const { readHistory } = reader([]);
    const { runner, sets } = watermark("100.3");

    const r = await runFetchSlackSync(
      { channel: "C1" },
      { cwd: "/repo", readHistory, store, watermarkRunner: runner },
    );

    expect(r.fetched).toBe(0);
    expect(r.watermark).toEqual({ from: "100.3", to: "100.3", advanced: false });
    expect(sets).toEqual([]); // monotonic: nothing to persist
  });

  test("a watermark read failure surfaces as FetchSlackError", async () => {
    const { store } = memStore();
    const { readHistory } = reader(MSGS);
    const runner = (): SpawnResult => ({ stdout: "", stderr: "permission denied", status: 1 });

    await expect(
      runFetchSlackSync(
        { channel: "C1" },
        { cwd: "/repo", readHistory, store, watermarkRunner: runner },
      ),
    ).rejects.toBeInstanceOf(FetchSlackError);
  });

  test("drains pages then advances once to the global max (prx-13x)", async () => {
    const { blobs, store } = memStore();
    const { runner, sets } = watermark(null);
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
      { cwd: "/repo", readHistory, store, watermarkRunner: runner },
    );

    expect(r.pages).toBe(2);
    expect(r.fetched).toBe(3);
    expect(blobs.size).toBe(3);
    // watermark persisted exactly once, to the global max across pages.
    expect(sets).toEqual([{ key: "prx.fetch.slack.C1.watermark", value: "1.3" }]);
  });

  test("forwards maxPages to the core to bound the drain", async () => {
    const { store } = memStore();
    const { runner } = watermark(null);
    let calls = 0;
    const readHistory = async () => {
      calls += 1;
      return { messages: [{ ts: `2.${calls}` }], cursor: `more-${calls}` }; // always more, advancing
    };

    const r = await runFetchSlackSync(
      { channel: "C1", maxPages: 3 },
      { cwd: "/repo", readHistory, store, watermarkRunner: runner },
    );

    expect(r.pages).toBe(3);
    expect(calls).toBe(3);
  });
});
