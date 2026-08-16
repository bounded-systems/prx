import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { CommandRunner } from "@bounded-systems/proc";

import {
  digestManifest,
  openAnchoredChain,
  sha256Hex,
  runPrEndToEnd,
  type Derivation,
  type Digest,
  type AnchoredChainStore,
} from "@bounded-systems/anchored-chain-sqlite";

import { createGhPrFetcher, prSurfaceRef } from "../gh-pr-fetcher.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_BEFORE = resolve(HERE, "../__fixtures__/gh-pr-1961-before.json");
const FIXTURE_AFTER = resolve(HERE, "../__fixtures__/gh-pr-1961-after.json");

const FIXTURE_BEFORE_JSON = readFileSync(FIXTURE_BEFORE, "utf8");
const FIXTURE_AFTER_JSON = readFileSync(FIXTURE_AFTER, "utf8");

/**
 * Scripted runner: returns the supplied stdout payloads in order.
 * The first call returns `payloads[0]`, the second returns `payloads[1]`,
 * etc. Past the end, it sticks on the last payload so `isFresh` probes
 * can keep matching the latest snapshot without a separate handler.
 */
function scriptedRunner(payloads: readonly string[]): CommandRunner {
  let calls = 0;
  return () => {
    const idx = Math.min(calls, payloads.length - 1);
    calls += 1;
    return { stdout: payloads[idx]!, stderr: "", status: 0 };
  };
}

let store: AnchoredChainStore;

beforeEach(() => {
  store = openAnchoredChain(":memory:");
});

afterEach(() => {
  store.close();
});

describe("gh-pr-fetcher.fetch", () => {
  test("digest is canonical-JSON-stable across two identical calls", async () => {
    const runner = scriptedRunner([FIXTURE_BEFORE_JSON, FIXTURE_BEFORE_JSON]);
    const fetcher = createGhPrFetcher({ runner });
    const ref = prSurfaceRef("GH-1961");

    const first = await fetcher.fetch(ref);
    const second = await fetcher.fetch(ref);

    expect(first.digest).toBe(second.digest);
    expect(first.freshnessSignal).toBe(second.freshnessSignal);
    expect(first.bytes.byteLength).toBeGreaterThan(0);
  });
});

describe("gh-pr-fetcher.isFresh", () => {
  test("returns true on matching updatedAt, false otherwise", async () => {
    const runner = scriptedRunner([FIXTURE_BEFORE_JSON, FIXTURE_BEFORE_JSON]);
    const fetcher = createGhPrFetcher({ runner });
    const ref = prSurfaceRef("GH-1961");

    expect(await fetcher.isFresh(ref, "2026-05-19T15:00:00Z")).toBe(true);
    expect(await fetcher.isFresh(ref, "2026-05-19T15:00:00Z")).toBe(true);
  });

  test("returns false when the freshness signal differs", async () => {
    const runner = scriptedRunner([FIXTURE_AFTER_JSON]);
    const fetcher = createGhPrFetcher({ runner });
    const ref = prSurfaceRef("GH-1961");

    expect(await fetcher.isFresh(ref, "2026-05-19T15:00:00Z")).toBe(false);
  });
});

describe("runPrEndToEnd", () => {
  test("first fetch advances pr/<unit> and appends a derivation with producer fetcher:gh-pr", async () => {
    const runner = scriptedRunner([FIXTURE_BEFORE_JSON]);
    const fetcher = createGhPrFetcher({ runner });
    const ref = prSurfaceRef("GH-1961");

    const result = await runPrEndToEnd({
      store,
      fetcher,
      surface: ref,
      now: 1,
    });

    expect(result.appended).toBe(true);
    expect(result.invalidated).toEqual([]);
    const refRow = await store.refs.get(ref.name);
    expect(refRow?.digest).toBe(result.refDigest);
    const derivation = await store.derivations.get(result.derivationId);
    expect(derivation?.manifest.producer).toBe("fetcher:gh-pr");
    expect(derivation?.manifest.outputs.pr).toBe(result.refDigest);
    expect(derivation?.manifest.params.refName).toBe(ref.name);
    expect(derivation?.manifest.params.freshnessSignal).toBe("2026-05-19T15:00:00Z");
  });

  test("second fetch with identical payload is a cache hit (no ref advance, no append)", async () => {
    const runner = scriptedRunner([FIXTURE_BEFORE_JSON, FIXTURE_BEFORE_JSON]);
    const fetcher = createGhPrFetcher({ runner });
    const ref = prSurfaceRef("GH-1961");

    const first = await runPrEndToEnd({ store, fetcher, surface: ref, now: 1 });
    const logBefore = await store.refs.log(ref.name);

    const second = await runPrEndToEnd({
      store,
      fetcher,
      surface: ref,
      now: 2,
    });

    expect(first.appended).toBe(true);
    expect(second.appended).toBe(false);
    expect(second.derivationId).toBe(first.derivationId);
    expect(second.invalidated).toEqual([]);
    const logAfter = await store.refs.log(ref.name);
    expect(logAfter).toHaveLength(logBefore.length);
  });

  test("third fetch with fresher fixture appends a new derivation and invalidates downstream consumers of the prior pr digest", async () => {
    const runner = scriptedRunner([FIXTURE_BEFORE_JSON, FIXTURE_BEFORE_JSON, FIXTURE_AFTER_JSON]);
    const fetcher = createGhPrFetcher({ runner });
    const ref = prSurfaceRef("GH-1961");

    const first = await runPrEndToEnd({ store, fetcher, surface: ref, now: 1 });

    // Seed a synthetic downstream derivation that consumes pr/<unit> as an
    // input so `invalidateDescendants` has something to find when the ref
    // advances. Without a downstream consumer the invalidation walk is
    // correctly empty — this stand-in represents whatever validator or
    // projection a real caller would chain onto the PR surface.
    const downstreamOutput = sha256Hex("downstream:GH-1961") as Digest;
    const downstreamManifest: Derivation["manifest"] = {
      producer: "validator:test-downstream",
      inputs: { pr: first.refDigest },
      outputs: { verdict: downstreamOutput },
      contracts: [],
      params: { refName: ref.name },
    };
    const downstreamId = digestManifest(downstreamManifest);
    await store.derivations.append({
      derivationId: downstreamId,
      manifest: downstreamManifest,
      ts: 1,
    });

    await runPrEndToEnd({ store, fetcher, surface: ref, now: 2 });
    const third = await runPrEndToEnd({
      store,
      fetcher,
      surface: ref,
      now: 3,
    });

    expect(third.appended).toBe(true);
    expect(third.derivationId).not.toBe(first.derivationId);
    expect(third.refDigest).not.toBe(first.refDigest);
    expect(third.invalidated).toContain(downstreamId);
    const refRow = await store.refs.get(ref.name);
    expect(refRow?.digest).toBe(third.refDigest);
  });
});
