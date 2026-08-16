import { chmodSync, existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  deleteBlob,
  getRef,
  hasBlob,
  listBlobs,
  listRefs,
  PlanStoreError,
  readBlob,
  resolveStoreRootForDisplay,
  setRef,
  writeBlob,
} from "../../src/plan-store/cas.ts";
import { CasUriError, casUriFor, parseCasUri } from "../../src/plan-store/uri.ts";

const ENV_KEYS = [
  "PRX_PLAN_STORE",
  "PRX_CAS_ROOT",
  "PRX_AI_HOME_ROOT",
  "BAKED_AI_HOME_ROOT",
  "PRX_OPERATOR_CONFIG_ROOT",
  "BAKED_OPERATOR_CONFIG_ROOT",
  "XDG_STATE_HOME",
  "HOME",
] as const;
type EnvSnapshot = Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

function snapshotEnv(): EnvSnapshot {
  const snap: EnvSnapshot = {};
  for (const k of ENV_KEYS) {
    snap[k] = process.env[k];
  }
  return snap;
}

function restoreEnv(snap: EnvSnapshot): void {
  for (const k of ENV_KEYS) {
    const v = snap[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}

describe("plan-store/cas", () => {
  let envSnap: EnvSnapshot;
  let storeRoot: string;

  beforeEach(() => {
    envSnap = snapshotEnv();
    storeRoot = mkdtempSync(join(tmpdir(), "prx-plan-store-"));
    for (const k of ENV_KEYS) {
      delete process.env[k];
    }
    process.env.PRX_PLAN_STORE = storeRoot;
  });

  afterEach(() => {
    restoreEnv(envSnap);
  });

  test("1. roundtrip: writeBlob → readBlob returns identical bytes", async () => {
    const { sha } = await writeBlob("hello");
    expect(sha).toMatch(/^sha256:[0-9a-f]{64}$/);
    const buf = await readBlob(sha);
    expect(buf.toString("utf8")).toBe("hello");
  });

  test("2. dedup: identical content produces identical sha and one on-disk file", async () => {
    const a = await writeBlob("x");
    const b = await writeBlob("x");
    expect(a.sha).toBe(b.sha);
    const hex = a.sha.slice("sha256:".length);
    const objDir = join(storeRoot, "objects", hex.slice(0, 2));
    expect(readdirSync(objDir).length).toBe(1);
  });

  test("3. buffer input roundtrips byte-identical", async () => {
    const input = Buffer.from([0, 1, 2, 0xff, 0xfe]);
    const { sha } = await writeBlob(input);
    const out = await readBlob(sha);
    expect(out.equals(input)).toBe(true);
  });

  test("4. setRef/getRef roundtrip", async () => {
    const { sha } = await writeBlob("plan-body");
    await setRef("GH-1174:plan", sha);
    expect(await getRef("GH-1174:plan")).toBe(sha);
  });

  test("hasBlob: true after write, false for an absent sha (prx-agd dedup gate)", async () => {
    const { sha } = await writeBlob("present");
    expect(await hasBlob(sha)).toBe(true);
    const absent = `sha256:${"0".repeat(64)}`;
    expect(await hasBlob(absent)).toBe(false);
  });

  test("hasBlob: rejects a malformed sha", async () => {
    await expect(hasBlob("not-a-sha")).rejects.toBeInstanceOf(PlanStoreError);
  });

  test("hasBlob: false after the blob is deleted", async () => {
    const { sha } = await writeBlob("ephemeral");
    expect(await hasBlob(sha)).toBe(true);
    await deleteBlob(sha);
    expect(await hasBlob(sha)).toBe(false);
  });

  test("5. ref overwrite: latest setRef wins", async () => {
    const a = await writeBlob("A");
    const b = await writeBlob("B");
    await setRef("k", a.sha);
    await setRef("k", b.sha);
    expect(await getRef("k")).toBe(b.sha);
  });

  test("6. missing ref returns null (not throw)", async () => {
    expect(await getRef("never-set")).toBeNull();
  });

  test("7. atomic ref under concurrent writes — final content is one input sha, no torn bytes", async () => {
    const shas: string[] = [];
    for (let i = 0; i < 8; i++) {
      const { sha } = await writeBlob(`payload-${i}`);
      shas.push(sha);
    }
    const writers: Promise<void>[] = [];
    for (let i = 0; i < 16; i++) {
      writers.push(setRef("race", shas[i % shas.length]!));
    }
    await Promise.all(writers);
    const final = await getRef("race");
    expect(final).not.toBeNull();
    expect(final).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(shas).toContain(final!);
  });

  test("8. auto-mkdir creates objects/refs/.tmp on first write", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "prx-plan-store-fresh-"));
    process.env.PRX_PLAN_STORE = fresh;
    const { sha } = await writeBlob("hi");
    expect(sha).toMatch(/^sha256:/);
    expect(statSync(join(fresh, "objects")).isDirectory()).toBe(true);
    expect(statSync(join(fresh, "refs")).isDirectory()).toBe(true);
    expect(statSync(join(fresh, ".tmp")).isDirectory()).toBe(true);
  });

  test("9. missing blob throws BLOB_NOT_FOUND", async () => {
    const sha = `sha256:${"0".repeat(64)}`;
    try {
      await readBlob(sha);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PlanStoreError);
      expect((err as PlanStoreError).code).toBe("BLOB_NOT_FOUND");
    }
  });

  test("10. invalid sha format throws INVALID_SHA", async () => {
    try {
      await readBlob("not-a-sha");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PlanStoreError);
      expect((err as PlanStoreError).code).toBe("INVALID_SHA");
    }
  });

  test("11. setRef rejects path-unsafe ref names with INVALID_REF_NAME", async () => {
    const { sha } = await writeBlob("body");
    const bad: string[] = ["", "..", "a/b", "a\\b", "a\0b", "ab", ".hidden", "x".repeat(257)];
    for (const name of bad) {
      let caught: unknown = null;
      try {
        await setRef(name, sha);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PlanStoreError);
      expect((caught as PlanStoreError).code).toBe("INVALID_REF_NAME");
    }
  });

  test("12. listRefs filters by prefix and returns sorted entries", async () => {
    const { sha } = await writeBlob("body");
    await setRef("A:plan", sha);
    await setRef("A:plan@draft", sha);
    await setRef("B:plan", sha);
    const got = await listRefs("A:");
    expect(got.map((r) => r.name)).toEqual(["A:plan", "A:plan@draft"]);
    for (const entry of got) {
      expect(entry.sha).toBe(sha);
    }
  });

  test("13. no store root: missing all env vars throws NO_STORE_ROOT", async () => {
    for (const k of ENV_KEYS) {
      delete process.env[k];
    }
    try {
      await writeBlob("anything");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PlanStoreError);
      expect((err as PlanStoreError).code).toBe("NO_STORE_ROOT");
    }
  });

  test("14. verify-on-read detects corruption (BLOB_CORRUPT)", async () => {
    const { sha } = await writeBlob("original");
    const hex = sha.slice("sha256:".length);
    const objPath = join(storeRoot, "objects", hex.slice(0, 2), hex.slice(2));
    chmodSync(objPath, 0o644);
    writeFileSync(objPath, "tampered");
    try {
      await readBlob(sha);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PlanStoreError);
      expect((err as PlanStoreError).code).toBe("BLOB_CORRUPT");
    }
  });

  test("15. setRef rejects dangling pointer (REF_TARGET_MISSING)", async () => {
    const phantom = `sha256:${"0".repeat(64)}`;
    try {
      await setRef("dangling", phantom);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PlanStoreError);
      expect((err as PlanStoreError).code).toBe("REF_TARGET_MISSING");
    }
  });

  test("16. size cap: blob > 10 MiB rejected with BLOB_TOO_LARGE", async () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1);
    try {
      await writeBlob(big);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PlanStoreError);
      expect((err as PlanStoreError).code).toBe("BLOB_TOO_LARGE");
    }
  });

  test("17. blob file mode is 0o444 after write", async () => {
    const { sha } = await writeBlob("locked");
    const hex = sha.slice("sha256:".length);
    const objPath = join(storeRoot, "objects", hex.slice(0, 2), hex.slice(2));
    expect(statSync(objPath).mode & 0o777).toBe(0o444);
  });

  test("18. PRX_PLAN_STORE rejects non-plans domain (legacy plans-only)", async () => {
    let caught: unknown = null;
    try {
      await writeBlob("body", { domain: "scout" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PlanStoreError);
    expect((caught as PlanStoreError).code).toBe("DOMAIN_NOT_AVAILABLE");
  });
});

describe("plan-store/cas multi-domain (PRX_CAS_ROOT)", () => {
  let envSnap: EnvSnapshot;
  let casRoot: string;

  beforeEach(() => {
    envSnap = snapshotEnv();
    casRoot = mkdtempSync(join(tmpdir(), "prx-cas-root-"));
    for (const k of ENV_KEYS) {
      delete process.env[k];
    }
    process.env.PRX_CAS_ROOT = casRoot;
  });

  afterEach(() => {
    restoreEnv(envSnap);
  });

  test("1. domain layout: <root>/<domain>/{objects,refs,.tmp}/", async () => {
    await writeBlob("scout-body", { domain: "scout" });
    expect(statSync(join(casRoot, "scout", "objects")).isDirectory()).toBe(true);
    expect(statSync(join(casRoot, "scout", "refs")).isDirectory()).toBe(true);
    expect(statSync(join(casRoot, "scout", ".tmp")).isDirectory()).toBe(true);
  });

  test("2. domain isolation: scout refs invisible to plans listings", async () => {
    const { sha } = await writeBlob("body", { domain: "scout" });
    await setRef("dispatch:plan:1", sha, { domain: "scout" });
    const scoutRefs = await listRefs(undefined, { domain: "scout" });
    const plansRefs = await listRefs(undefined, { domain: "plans" });
    expect(scoutRefs.map((r) => r.name)).toEqual(["dispatch:plan:1"]);
    expect(plansRefs).toEqual([]);
  });

  test("3. domain isolation: same content in two domains writes two on-disk blobs", async () => {
    const { sha: scoutSha } = await writeBlob("identical", { domain: "scout" });
    const { sha: plansSha } = await writeBlob("identical", { domain: "plans" });
    expect(scoutSha).toBe(plansSha);
    const hex = scoutSha.slice("sha256:".length);
    const scoutFile = join(casRoot, "scout", "objects", hex.slice(0, 2), hex.slice(2));
    const plansFile = join(casRoot, "plans", "objects", hex.slice(0, 2), hex.slice(2));
    expect(statSync(scoutFile).isFile()).toBe(true);
    expect(statSync(plansFile).isFile()).toBe(true);
  });

  test("4. domain isolation: getRef in wrong domain returns null", async () => {
    const { sha } = await writeBlob("body", { domain: "scout" });
    await setRef("k", sha, { domain: "scout" });
    expect(await getRef("k", { domain: "scout" })).toBe(sha);
    expect(await getRef("k", { domain: "plans" })).toBeNull();
  });

  test("5. setRef cross-domain: REF_TARGET_MISSING when blob not in target domain", async () => {
    const { sha } = await writeBlob("body", { domain: "scout" });
    let caught: unknown = null;
    try {
      await setRef("k", sha, { domain: "plans" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PlanStoreError);
    expect((caught as PlanStoreError).code).toBe("REF_TARGET_MISSING");
  });

  test("6. invalid domain shape rejected with INVALID_DOMAIN", async () => {
    const bad = ["", "Plans", "1plans", "plans/x", "plans..x", "plans.x"];
    for (const domain of bad) {
      let caught: unknown = null;
      try {
        await writeBlob("body", { domain });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PlanStoreError);
      expect((caught as PlanStoreError).code).toBe("INVALID_DOMAIN");
    }
  });

  test("7. default domain is 'plans' when omitted", async () => {
    const { sha } = await writeBlob("default-domain-body");
    expect(
      statSync(
        join(
          casRoot,
          "plans",
          "objects",
          sha.slice("sha256:".length, "sha256:".length + 2),
          sha.slice("sha256:".length + 2),
        ),
      ).isFile(),
    ).toBe(true);
  });
});

describe("plan-store/cas — PRX_AI_HOME_ROOT is NOT a CAS surface (prx-z27)", () => {
  let envSnap: EnvSnapshot;
  let aiHome: string;
  let xdgState: string;

  beforeEach(() => {
    envSnap = snapshotEnv();
    aiHome = mkdtempSync(join(tmpdir(), "prx-ai-home-"));
    xdgState = mkdtempSync(join(tmpdir(), "prx-xdg-state-"));
    for (const k of ENV_KEYS) {
      delete process.env[k];
    }
    process.env.PRX_AI_HOME_ROOT = aiHome;
    process.env.XDG_STATE_HOME = xdgState;
  });

  afterEach(() => {
    restoreEnv(envSnap);
  });

  test("CAS ignores PRX_AI_HOME_ROOT and writes under XDG_STATE_HOME", async () => {
    const { sha } = await writeBlob("ai-home-ignored-body");
    const hex = sha.slice("sha256:".length);
    expect(
      statSync(
        join(xdgState, "prx", "cas", "plans", "objects", hex.slice(0, 2), hex.slice(2)),
      ).isFile(),
    ).toBe(true);
    // The CAS owns its surface — nothing is created under the overlay-config root.
    expect(existsSync(join(aiHome, ".prx"))).toBe(false);
  });

  test("a read-only /nix/store PRX_AI_HOME_ROOT is harmless — CAS still uses XDG", async () => {
    process.env.PRX_AI_HOME_ROOT = "/nix/store/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-ai-home-source";
    const { sha } = await writeBlob("store-root-ignored-body");
    const hex = sha.slice("sha256:".length);
    expect(
      statSync(
        join(xdgState, "prx", "cas", "plans", "objects", hex.slice(0, 2), hex.slice(2)),
      ).isFile(),
    ).toBe(true);
  });
});

describe("plan-store/cas read-only root (prx-1ke)", () => {
  let envSnap: EnvSnapshot;
  let casRoot: string;

  beforeEach(() => {
    envSnap = snapshotEnv();
    casRoot = mkdtempSync(join(tmpdir(), "prx-ro-cas-root-"));
    for (const k of ENV_KEYS) {
      delete process.env[k];
    }
    process.env.PRX_CAS_ROOT = casRoot;
  });

  afterEach(() => {
    // Restore write so the OS can clean up the temp dir.
    try {
      chmodSync(casRoot, 0o700);
    } catch {
      // best-effort
    }
    restoreEnv(envSnap);
  });

  test("writeBlob under a read-only PRX_CAS_ROOT throws a clear PlanStoreError, not raw EACCES", async () => {
    // Strip write perms from the resolved root so ensureLayout's mkdir fails.
    chmodSync(casRoot, 0o500);
    let caught: unknown;
    try {
      await writeBlob("body-into-readonly-root");
    } catch (err) {
      caught = err;
    }
    // If the mkdir somehow succeeded (e.g. running as root, where perms don't
    // apply), there's nothing to assert — the suite assumes a non-root runner.
    if (caught === undefined) {
      return;
    }
    expect(caught).toBeInstanceOf(PlanStoreError);
    expect((caught as PlanStoreError).code).toBe("STORE_ROOT_NOT_WRITABLE");
    expect((caught as Error).message).toContain("PRX_CAS_ROOT");
  });
});

describe("plan-store/cas XDG default fallback (GH-1226)", () => {
  let envSnap: EnvSnapshot;
  let xdgState: string;
  let home: string;

  beforeEach(() => {
    envSnap = snapshotEnv();
    xdgState = mkdtempSync(join(tmpdir(), "prx-xdg-state-"));
    home = mkdtempSync(join(tmpdir(), "prx-home-"));
    for (const k of ENV_KEYS) {
      delete process.env[k];
    }
  });

  afterEach(() => {
    restoreEnv(envSnap);
  });

  test("writes default to $XDG_STATE_HOME/prx/cas/<domain> when no PRX_* vars set", async () => {
    process.env.XDG_STATE_HOME = xdgState;
    process.env.HOME = home;
    const { sha } = await writeBlob("xdg-default-body");
    const hex = sha.slice("sha256:".length);
    expect(
      statSync(
        join(xdgState, "prx", "cas", "plans", "objects", hex.slice(0, 2), hex.slice(2)),
      ).isFile(),
    ).toBe(true);
  });

  test("falls back to $HOME/.local/state/prx/cas/<domain> when XDG_STATE_HOME unset", async () => {
    process.env.HOME = home;
    const { sha } = await writeBlob("home-default-body");
    const hex = sha.slice("sha256:".length);
    expect(
      statSync(
        join(
          home,
          ".local",
          "state",
          "prx",
          "cas",
          "plans",
          "objects",
          hex.slice(0, 2),
          hex.slice(2),
        ),
      ).isFile(),
    ).toBe(true);
  });

  test("non-plans domain also routes through XDG default", async () => {
    process.env.XDG_STATE_HOME = xdgState;
    process.env.HOME = home;
    const { sha } = await writeBlob("scout-body", { domain: "scout" });
    const hex = sha.slice("sha256:".length);
    expect(
      statSync(
        join(xdgState, "prx", "cas", "scout", "objects", hex.slice(0, 2), hex.slice(2)),
      ).isFile(),
    ).toBe(true);
  });

  test("PRX_CAS_ROOT takes precedence over XDG default", async () => {
    const cas = mkdtempSync(join(tmpdir(), "prx-cas-precedence-"));
    process.env.PRX_CAS_ROOT = cas;
    process.env.XDG_STATE_HOME = xdgState;
    process.env.HOME = home;
    const { sha } = await writeBlob("cas-wins-body");
    const hex = sha.slice("sha256:".length);
    expect(statSync(join(cas, "plans", "objects", hex.slice(0, 2), hex.slice(2))).isFile()).toBe(
      true,
    );
    expect(existsSync(join(xdgState, "prx", "cas", "plans"))).toBe(false);
  });

  test("PRX_PLAN_STORE takes precedence over XDG default", async () => {
    const legacy = mkdtempSync(join(tmpdir(), "prx-plan-store-precedence-"));
    process.env.PRX_PLAN_STORE = legacy;
    process.env.XDG_STATE_HOME = xdgState;
    process.env.HOME = home;
    const { sha } = await writeBlob("plan-store-wins-body");
    const hex = sha.slice("sha256:".length);
    expect(statSync(join(legacy, "objects", hex.slice(0, 2), hex.slice(2))).isFile()).toBe(true);
    expect(existsSync(join(xdgState, "prx", "cas", "plans"))).toBe(false);
  });

  test("PRX_AI_HOME_ROOT does NOT precede XDG — CAS ignores it (prx-z27)", async () => {
    const aiHome = mkdtempSync(join(tmpdir(), "prx-ai-home-precedence-"));
    process.env.PRX_AI_HOME_ROOT = aiHome;
    process.env.XDG_STATE_HOME = xdgState;
    process.env.HOME = home;
    const { sha } = await writeBlob("ai-home-ignored-body");
    const hex = sha.slice("sha256:".length);
    // CAS owns its surface → writes under XDG_STATE_HOME, never PRX_AI_HOME_ROOT.
    expect(
      statSync(
        join(xdgState, "prx", "cas", "plans", "objects", hex.slice(0, 2), hex.slice(2)),
      ).isFile(),
    ).toBe(true);
    expect(existsSync(join(aiHome, ".prx"))).toBe(false);
  });

  test("BAKED_AI_HOME_ROOT is ignored (no longer in CAS fallback chain)", async () => {
    const baked = mkdtempSync(join(tmpdir(), "prx-baked-sentinel-"));
    process.env.BAKED_AI_HOME_ROOT = baked;
    process.env.XDG_STATE_HOME = xdgState;
    process.env.HOME = home;
    const { sha } = await writeBlob("baked-ignored-body");
    const hex = sha.slice("sha256:".length);
    expect(
      statSync(
        join(xdgState, "prx", "cas", "plans", "objects", hex.slice(0, 2), hex.slice(2)),
      ).isFile(),
    ).toBe(true);
    expect(existsSync(join(baked, ".prx"))).toBe(false);
  });

  test("BAKED_AI_HOME_ROOT alone (no HOME, no XDG) throws NO_STORE_ROOT", async () => {
    process.env.BAKED_AI_HOME_ROOT = mkdtempSync(join(tmpdir(), "prx-baked-only-"));
    let caught: unknown = null;
    try {
      await writeBlob("anything");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PlanStoreError);
    expect((caught as PlanStoreError).code).toBe("NO_STORE_ROOT");
  });
});

describe("plan-store/cas resolveStoreRootForDisplay (GH-1226)", () => {
  let envSnap: EnvSnapshot;

  beforeEach(() => {
    envSnap = snapshotEnv();
    for (const k of ENV_KEYS) {
      delete process.env[k];
    }
  });

  afterEach(() => {
    restoreEnv(envSnap);
  });

  test("labels PRX_CAS_ROOT branch", () => {
    process.env.PRX_CAS_ROOT = "/tmp/cas-x";
    const r = resolveStoreRootForDisplay("plans");
    expect(r.source).toBe("PRX_CAS_ROOT");
    expect(r.root).toBe("/tmp/cas-x/plans");
  });

  test("labels PRX_PLAN_STORE branch", () => {
    process.env.PRX_PLAN_STORE = "/tmp/legacy-x";
    const r = resolveStoreRootForDisplay("plans");
    expect(r.source).toBe("PRX_PLAN_STORE");
    expect(r.root).toBe("/tmp/legacy-x");
  });

  test("labels XDG_STATE_HOME branch even when PRX_AI_HOME_ROOT is set (prx-z27: CAS ignores it)", () => {
    process.env.PRX_AI_HOME_ROOT = "/tmp/no-such-ai-home";
    process.env.XDG_STATE_HOME = "/tmp/xdg-x";
    process.env.HOME = "/tmp/home-x";
    const r = resolveStoreRootForDisplay("plans");
    expect(r.source).toBe("XDG_STATE_HOME");
    expect(r.root).toBe("/tmp/xdg-x/prx/cas/plans");
  });

  test("labels XDG_STATE_HOME branch", () => {
    process.env.XDG_STATE_HOME = "/tmp/xdg-x";
    process.env.HOME = "/tmp/home-x";
    const r = resolveStoreRootForDisplay("plans");
    expect(r.source).toBe("XDG_STATE_HOME");
    expect(r.root).toBe("/tmp/xdg-x/prx/cas/plans");
  });

  test("labels XDG_STATE_HOME (default) when only HOME is set", () => {
    process.env.HOME = "/tmp/home-x";
    const r = resolveStoreRootForDisplay("plans");
    expect(r.source).toBe("XDG_STATE_HOME (default)");
    expect(r.root).toBe("/tmp/home-x/.local/state/prx/cas/plans");
  });

  test("ignores BAKED_AI_HOME_ROOT", () => {
    process.env.BAKED_AI_HOME_ROOT = "/nix/store/fake/source";
    process.env.HOME = "/tmp/home-x";
    const r = resolveStoreRootForDisplay("plans");
    expect(r.source).toBe("XDG_STATE_HOME (default)");
    expect(r.root).toBe("/tmp/home-x/.local/state/prx/cas/plans");
  });

  test("throws NO_STORE_ROOT when nothing resolves", () => {
    let caught: unknown = null;
    try {
      resolveStoreRootForDisplay("plans");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PlanStoreError);
    expect((caught as PlanStoreError).code).toBe("NO_STORE_ROOT");
  });
});

describe("plan-store/uri (casUriFor / parseCasUri)", () => {
  test("1. casUriFor composes <domain>://sha256:<hex>", () => {
    const sha = `sha256:${"a".repeat(64)}`;
    expect(casUriFor("scout", sha)).toBe(`scout://${sha}`);
    expect(casUriFor("plans", sha)).toBe(`plans://${sha}`);
  });

  test("2. parseCasUri inverse roundtrip", () => {
    const sha = `sha256:${"f".repeat(64)}`;
    const uri = casUriFor("scout", sha);
    const parsed = parseCasUri(uri);
    expect(parsed.domain).toBe("scout");
    expect(parsed.sha).toBe(sha);
  });

  test("3. casUriFor rejects invalid domain", () => {
    const sha = `sha256:${"0".repeat(64)}`;
    for (const domain of ["", "Scout", "1scout", "scout/x", "scout.x"]) {
      let caught: unknown = null;
      try {
        casUriFor(domain, sha);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(CasUriError);
      expect((caught as CasUriError).code).toBe("INVALID_DOMAIN");
    }
  });

  test("4. casUriFor rejects invalid sha", () => {
    let caught: unknown = null;
    try {
      casUriFor("scout", "not-a-sha");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CasUriError);
    expect((caught as CasUriError).code).toBe("INVALID_SHA");
  });

  test("5. parseCasUri rejects malformed inputs", () => {
    for (const uri of [
      "",
      "scout://",
      "scout://sha256:short",
      "scout:/sha256:" + "a".repeat(64),
      "Scout://sha256:" + "a".repeat(64),
      "sha256:" + "a".repeat(64),
    ]) {
      let caught: unknown = null;
      try {
        parseCasUri(uri);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(CasUriError);
      expect((caught as CasUriError).code).toBe("INVALID_URI");
    }
  });

  test("6. parseCasUri enforces MAX_DOMAIN at the boundary", () => {
    const longDomain = "a".repeat(65);
    const sha = `sha256:${"a".repeat(64)}`;
    let caught: unknown = null;
    try {
      parseCasUri(`${longDomain}://${sha}`);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CasUriError);
    expect((caught as CasUriError).code).toBe("INVALID_URI");
    expect((caught as CasUriError).message).toContain("domain too long");
  });
});

describe("plan-store/cas — listBlobs + deleteBlob (GH-2312)", () => {
  let envSnap: EnvSnapshot;
  beforeEach(() => {
    envSnap = snapshotEnv();
    for (const k of ENV_KEYS) {
      delete process.env[k];
    }
    process.env.PRX_PLAN_STORE = mkdtempSync(join(tmpdir(), "prx-cas-gc-"));
  });
  afterEach(() => {
    restoreEnv(envSnap);
  });

  test("listBlobs: missing/empty objects dir → []", async () => {
    expect(await listBlobs()).toEqual([]);
  });

  test("listBlobs: N distinct blobs → N entries with sha + bytes + mtimeMs", async () => {
    const a = await writeBlob("alpha"); // 5 bytes
    const b = await writeBlob("bravocharlie"); // 12 bytes
    const byShaList = await listBlobs();
    expect(byShaList).toHaveLength(2);
    const byShaMap = new Map(byShaList.map((x) => [x.sha, x]));
    expect(byShaMap.get(a.sha)?.bytes).toBe(5);
    expect(byShaMap.get(b.sha)?.bytes).toBe(12);
    expect(byShaMap.get(a.sha)?.mtimeMs).toBeGreaterThan(0);
  });

  test("listBlobs: dedup write → one entry", async () => {
    await writeBlob("dup");
    await writeBlob("dup");
    expect(await listBlobs()).toHaveLength(1);
  });

  test("deleteBlob: removes the object (readBlob → BLOB_NOT_FOUND) + prunes the empty shard", async () => {
    const { sha } = await writeBlob("to-delete");
    await deleteBlob(sha);
    await expect(readBlob(sha)).rejects.toMatchObject({ code: "BLOB_NOT_FOUND" });
    expect(await listBlobs()).toEqual([]);
  });

  test("deleteBlob: idempotent — an already-absent blob does not throw", async () => {
    const { sha } = await writeBlob("once");
    await deleteBlob(sha);
    await deleteBlob(sha); // no throw
    expect(await listBlobs()).toEqual([]);
  });

  test("deleteBlob: deleting one blob leaves the others intact", async () => {
    const keep = await writeBlob("keep-me");
    const drop = await writeBlob("remove-me");
    await deleteBlob(drop.sha);
    expect((await listBlobs()).map((x) => x.sha)).toEqual([keep.sha]);
  });

  test("deleteBlob: malformed sha → INVALID_SHA", async () => {
    await expect(deleteBlob("not-a-sha")).rejects.toMatchObject({ code: "INVALID_SHA" });
  });
});
