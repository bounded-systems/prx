import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  openAnchoredChain,
  RefMismatchError,
  type Derivation,
  type Digest,
  type AnchoredChainStore,
} from "@bounded-systems/anchored-chain-sqlite";

let store: AnchoredChainStore;

beforeEach(() => {
  store = openAnchoredChain(":memory:");
});

afterEach(() => {
  store.close();
});

const D = (s: string) => `sha256:${s.padEnd(64, "0")}` as Digest;

describe("schema bootstrap", () => {
  test("opening a fresh :memory: store applies migrations", async () => {
    expect(await store.refs.get("any")).toBeNull();
  });
});

describe("RefStore.cas happy path", () => {
  test("first-write inserts the row and advances log", async () => {
    const ref = await store.refs.cas({
      name: "main",
      prevDigest: null,
      newDigest: D("aa"),
      reason: "init",
      ts: 1,
    });
    expect(ref.digest).toBe(D("aa"));
    const fetched = await store.refs.get("main");
    expect(fetched?.digest).toBe(D("aa"));
    const log = await store.refs.log("main");
    expect(log).toHaveLength(1);
    expect(log[0]!.prevDigest).toBeNull();
    expect(log[0]!.newDigest).toBe(D("aa"));
  });

  test("subsequent CAS advances ref and log when prev matches", async () => {
    await store.refs.cas({
      name: "main",
      prevDigest: null,
      newDigest: D("aa"),
      reason: "init",
      ts: 1,
    });
    await store.refs.cas({
      name: "main",
      prevDigest: D("aa"),
      newDigest: D("bb"),
      reason: "advance",
      ts: 2,
    });
    expect((await store.refs.get("main"))?.digest).toBe(D("bb"));
    expect(await store.refs.log("main")).toHaveLength(2);
  });
});

describe("RefStore.cas race detection", () => {
  test("concurrent attempts with same prev — exactly one wins, other throws RefMismatchError", async () => {
    await store.refs.cas({
      name: "main",
      prevDigest: null,
      newDigest: D("00"),
      reason: "init",
      ts: 0,
    });
    for (let i = 1; i <= 50; i++) {
      const local = openAnchoredChain(":memory:");
      await local.refs.cas({
        name: "main",
        prevDigest: null,
        newDigest: D("00"),
        reason: "init",
        ts: 0,
      });
      const prev = D("00");
      const results = await Promise.allSettled([
        local.refs.cas({
          name: "main",
          prevDigest: prev,
          newDigest: D(`a${i}`),
          reason: "a",
          ts: i,
        }),
        local.refs.cas({
          name: "main",
          prevDigest: prev,
          newDigest: D(`b${i}`),
          reason: "b",
          ts: i,
        }),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const rejection = rejected[0] as PromiseRejectedResult;
      expect(rejection.reason).toBeInstanceOf(RefMismatchError);
      local.close();
    }
  });

  test("first-write race — two prev=null attempts; exactly one wins", async () => {
    for (let i = 0; i < 50; i++) {
      const local = openAnchoredChain(":memory:");
      const results = await Promise.allSettled([
        local.refs.cas({
          name: "main",
          prevDigest: null,
          newDigest: D(`a${i}`),
          reason: "a",
          ts: i,
        }),
        local.refs.cas({
          name: "main",
          prevDigest: null,
          newDigest: D(`b${i}`),
          reason: "b",
          ts: i,
        }),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const rejection = rejected[0] as PromiseRejectedResult;
      expect(rejection.reason).toBeInstanceOf(RefMismatchError);
      local.close();
    }
  });
});

describe("RefStore.asOf", () => {
  test("returns the most recent log entry with ts <= T", async () => {
    await store.refs.cas({
      name: "main",
      prevDigest: null,
      newDigest: D("aa"),
      reason: "init",
      ts: 10,
    });
    await store.refs.cas({
      name: "main",
      prevDigest: D("aa"),
      newDigest: D("bb"),
      reason: "second",
      ts: 20,
    });
    await store.refs.cas({
      name: "main",
      prevDigest: D("bb"),
      newDigest: D("cc"),
      reason: "third",
      ts: 30,
    });
    expect(await store.refs.asOf("main", 5)).toBeNull();
    expect((await store.refs.asOf("main", 10))?.newDigest).toBe(D("aa"));
    expect((await store.refs.asOf("main", 15))?.newDigest).toBe(D("aa"));
    expect((await store.refs.asOf("main", 25))?.newDigest).toBe(D("bb"));
    expect((await store.refs.asOf("main", 100))?.newDigest).toBe(D("cc"));
  });
});

describe("DerivationStore", () => {
  test("append + get + listInputs/Outputs round-trip", async () => {
    const der: Derivation = {
      derivationId: D("d1"),
      manifest: {
        producer: "noop",
        inputs: { surfA: D("ia"), surfB: D("ib") },
        outputs: { out1: D("o1") },
        contracts: ["c/v1"],
        params: { mode: "demo" },
      },
      ts: 100,
    };
    await store.derivations.append(der);
    const got = await store.derivations.get(D("d1"));
    expect(got?.derivationId).toBe(D("d1"));
    expect(got?.manifest.producer).toBe("noop");
    expect(got?.manifest.inputs.surfA).toBe(D("ia"));
    const inputs = await store.derivations.listInputs(D("d1"));
    expect(inputs).toHaveLength(2);
    const outputs = await store.derivations.listOutputs(D("d1"));
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.outputDigest).toBe(D("o1"));
  });

  test("get of unknown derivation returns null", async () => {
    expect(await store.derivations.get(D("ff"))).toBeNull();
  });

  test("derivationsByOutput is the inverse of listOutputs", async () => {
    const der: Derivation = {
      derivationId: D("d1"),
      manifest: {
        producer: "noop",
        inputs: {},
        outputs: { commit: D("o1") },
        contracts: [],
        params: {},
      },
      ts: 100,
    };
    await store.derivations.append(der);
    expect(await store.derivations.derivationsByOutput(D("o1"))).toEqual([D("d1")]);
  });

  test("derivationsByOutput returns every derivation producing the digest", async () => {
    const mk = (id: string): Derivation => ({
      derivationId: D(id),
      manifest: {
        producer: "noop",
        inputs: {},
        outputs: { commit: D("shared") },
        contracts: [],
        params: { id },
      },
      ts: 1,
    });
    await store.derivations.append(mk("a"));
    await store.derivations.append(mk("b"));
    const ids = await store.derivations.derivationsByOutput(D("shared"));
    expect([...ids].sort()).toEqual([D("a"), D("b")].sort());
  });

  test("derivationsByOutput de-dupes when one derivation emits the digest twice", async () => {
    const der: Derivation = {
      derivationId: D("d1"),
      manifest: {
        producer: "noop",
        inputs: {},
        outputs: { commit: D("o1"), alias: D("o1") },
        contracts: [],
        params: {},
      },
      ts: 1,
    };
    await store.derivations.append(der);
    expect(await store.derivations.derivationsByOutput(D("o1"))).toEqual([D("d1")]);
  });

  test("derivationsByOutput of an unknown digest is empty", async () => {
    expect(await store.derivations.derivationsByOutput(D("nope"))).toEqual([]);
  });
});
