/**
 * gc `cas` driver (GH-2312 plans / GH-2317 submit) — the data-loss-critical
 * tests. Primary vehicle is a domain-aware in-memory stub `CasGcOps`
 * (deterministic, offline; the multi-domain driver queries plans AND submit, so
 * the stub returns its fixture only for the domain under test). One real-temp
 * CAS e2e per domain proves a referenced child blob survives a real sweep.
 *
 * The e2e MUST scope every domain via PRX_CAS_ROOT — the driver collects both
 * plans and submit, so a plans-only PRX_PLAN_STORE would leave submit resolving
 * to the operator's real CAS.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { markFindings } from "../../../../src/machine/gc/capability.ts";
import { createCasDriver } from "../../../../src/machine/gc/drivers/cas.ts";
import type { CasGcOps, GcDriverDeps } from "../../../../src/machine/gc/drivers/registry.ts";
import {
  deleteBlob,
  listBlobs,
  listRefs,
  PlanStoreError,
  readBlob,
  setRef,
  writeBlob,
  type CasSha,
} from "../../../../src/plan-store/cas.ts";
import { casUriFor } from "../../../../src/plan-store/uri.ts";

// Map any label to a valid, distinct 64-hex sha (casUriFor validates the hex).
const sha = (label: string): CasSha =>
  `sha256:${Buffer.from(label).toString("hex").padEnd(64, "0").slice(0, 64)}`;
const uri = casUriFor;
const envelopeJson = (bodySha: CasSha): string =>
  JSON.stringify({ schema_version: 1, body_sha: bodySha, validated_ok: true, diagnostics: [] });
const submitArtifactJson = (patchSha: CasSha): string =>
  JSON.stringify({
    workUnitId: "GH-1",
    baseRef: "main",
    baseSha: "1".repeat(40),
    tree: { sha: "2".repeat(40) },
    patch: { sha: patchSha, bytes: 10 },
    summary: "x",
    createdAt: "2026-05-29T00:00:00.000Z",
  });

type StubBlob = { sha: CasSha; content?: string; bytes?: number; mtimeMs?: number; throwOnRead?: boolean };
type Ref = { name: string; sha: CasSha };

/** Domain-aware stub: serves its fixture only for `domain` (default "plans"),
 * empty elsewhere — so the multi-domain driver doesn't double-count. */
function casStub(init: { refs?: Ref[]; blobs?: StubBlob[]; graceMs?: number; domain?: string }): {
  cas: CasGcOps;
  state: { refs: Ref[]; blobs: StubBlob[]; deleted: CasSha[] };
} {
  const dom = init.domain ?? "plans";
  const state = { refs: init.refs ?? [], blobs: init.blobs ?? [], deleted: [] as CasSha[] };
  const here = (opts?: { domain?: string }) => (opts?.domain ?? "plans") === dom;
  const cas = {
    listRefs: async (_p?: string, opts?: { domain?: string }) => (here(opts) ? state.refs : []),
    readBlob: async (s: CasSha, opts?: { domain?: string }) => {
      const b = here(opts) ? state.blobs.find((x) => x.sha === s) : undefined;
      if (!b || b.throwOnRead) throw new PlanStoreError(`blob not found: ${s}`, "BLOB_NOT_FOUND");
      return Buffer.from(b.content ?? "");
    },
    listBlobs: async (opts?: { domain?: string }) =>
      here(opts)
        ? state.blobs.map((b) => ({ sha: b.sha, bytes: b.bytes ?? (b.content?.length ?? 0), mtimeMs: b.mtimeMs ?? 0 }))
        : [],
    deleteBlob: async (s: CasSha, opts?: { domain?: string }) => {
      if (!here(opts)) return;
      state.deleted.push(s);
      state.blobs = state.blobs.filter((b) => b.sha !== s);
    },
    graceMs: init.graceMs ?? 0,
  } as unknown as CasGcOps;
  return { cas, state };
}

const driverFor = (cas: CasGcOps) => createCasDriver({ cas } as unknown as GcDriverDeps);
async function markThenSweep(cas: CasGcOps) {
  const driver = driverFor(cas);
  const findings = await driver.mark();
  const out = await driver.sweep(markFindings("cas", findings), {});
  return { findings, out };
}

describe("createCasDriver — plans rooting (GH-2028 data-loss guards)", () => {
  test("an unreferenced blob is swept (finding is a domain-qualified CAS URI)", async () => {
    const { cas, state } = casStub({ blobs: [{ sha: sha("a"), bytes: 42, mtimeMs: 0 }] });
    const { findings, out } = await markThenSweep(cas);
    expect(findings[0]).toMatchObject({ component: "cas", class: "orphan", ref: uri("plans", sha("a")), reclaim_bytes: 42 });
    expect(out.reclaimed).toHaveLength(1);
    expect(state.deleted).toEqual([sha("a")]); // sweep deletes the bare sha in the right domain
  });

  test("the envelope body (2nd hop) is NEVER swept", async () => {
    const env = sha("e");
    const body = sha("b");
    const orphan = sha("o");
    const { cas, state } = casStub({
      refs: [{ name: "GH-1:plan@approved", sha: env }],
      blobs: [{ sha: env, content: envelopeJson(body) }, { sha: body, content: "the plan body" }, { sha: orphan, content: "junk" }],
    });
    const { out } = await markThenSweep(cas);
    expect(out.reclaimed.map((f) => f.ref)).toEqual([uri("plans", orphan)]);
    expect(state.deleted).toEqual([orphan]);
  });

  test("a legacy bare-sha ref (body, no envelope) is NEVER swept", async () => {
    const body = sha("b");
    const orphan = sha("o");
    const { cas, state } = casStub({
      refs: [{ name: "GH-1:plan@draft", sha: body }],
      blobs: [{ sha: body, content: "raw legacy plan body" }, { sha: orphan, content: "junk" }],
    });
    await markThenSweep(cas);
    expect(state.deleted).toEqual([orphan]);
  });

  test("envelope present but body blob missing → mark does not throw", async () => {
    const env = sha("e");
    const orphan = sha("o");
    const { cas } = casStub({
      refs: [{ name: "GH-1:plan@approved", sha: env }],
      blobs: [{ sha: env, content: envelopeJson(sha("b")) }, { sha: orphan, content: "junk" }],
    });
    expect((await driverFor(cas).mark()).map((f) => f.ref)).toEqual([uri("plans", orphan)]);
  });

  test("a corrupt/unreadable ref blob keeps its ref rooted; mark does not crash (S7)", async () => {
    const bad = sha("d");
    const orphan = sha("o");
    const { cas, state } = casStub({
      refs: [{ name: "GH-1:plan@approved", sha: bad }],
      blobs: [{ sha: bad, throwOnRead: true }, { sha: orphan, content: "junk" }],
    });
    await markThenSweep(cas);
    expect(state.deleted).toEqual([orphan]); // bad ref rooted, not swept
  });
});

describe("createCasDriver — submit rooting (GH-2317 data-loss guards)", () => {
  test("the patch blob a submit artifact references is NEVER swept", async () => {
    const meta = sha("m");
    const patch = sha("p");
    const orphan = sha("o");
    const { cas, state } = casStub({
      domain: "submit",
      refs: [{ name: "GH-1:submit@ready", sha: meta }],
      blobs: [{ sha: meta, content: submitArtifactJson(patch) }, { sha: patch, content: "the diff" }, { sha: orphan, content: "junk" }],
    });
    const { out } = await markThenSweep(cas);
    expect(out.reclaimed.map((f) => f.ref)).toEqual([uri("submit", orphan)]); // submit-qualified
    expect(state.deleted).toEqual([orphan]); // metadata + patch survive
  });

  test("an orphan submit blob is swept; a malformed metadata blob keeps its ref rooted", async () => {
    const badMeta = sha("m");
    const orphan = sha("o");
    const { cas, state } = casStub({
      domain: "submit",
      refs: [{ name: "GH-1:submit@draft", sha: badMeta }],
      blobs: [{ sha: badMeta, content: "not-a-submit-artifact" }, { sha: orphan, content: "junk" }],
    });
    await markThenSweep(cas);
    expect(state.deleted).toEqual([orphan]); // badMeta rooted (parse miss → fail-safe)
  });
});

describe("createCasDriver — TOCTOU + grace + capability", () => {
  test("a blob referenced between mark and sweep is NOT swept", async () => {
    const orphan = sha("o");
    const { cas, state } = casStub({ blobs: [{ sha: orphan, content: "x" }] });
    const driver = driverFor(cas);
    const findings = await driver.mark();
    expect(findings.map((f) => f.ref)).toEqual([uri("plans", orphan)]);
    state.refs.push({ name: "GH-9:plan@draft", sha: orphan }); // now rooted
    const out = await driver.sweep(markFindings("cas", findings), {});
    expect(out.reclaimed).toEqual([]);
    expect(state.deleted).toEqual([]);
  });

  test("grace guard: a recent orphan is skipped; with graceMs=0 it is swept", async () => {
    const tenMinAgo = Date.now() - 10 * 60 * 1000;
    const guarded = casStub({ blobs: [{ sha: sha("a"), mtimeMs: tenMinAgo }], graceMs: 60 * 60 * 1000 });
    expect(await driverFor(guarded.cas).mark()).toEqual([]);
    const eager = casStub({ blobs: [{ sha: sha("a"), mtimeMs: tenMinAgo }], graceMs: 0 });
    expect(await driverFor(eager.cas).mark()).toHaveLength(1);
  });

  test("no-op without an injected cas dep", async () => {
    const driver = createCasDriver({ repoPath: "/x" } as unknown as GcDriverDeps);
    expect(await driver.mark()).toEqual([]);
    expect(await driver.sweep(markFindings("cas", []), {})).toEqual({ reclaimed: [] });
  });
});

describe("createCasDriver — real temp CAS e2e (data-loss guard against a real store)", () => {
  const ENV = ["PRX_CAS_ROOT", "PRX_PLAN_STORE", "PRX_AI_HOME_ROOT", "BAKED_AI_HOME_ROOT", "XDG_STATE_HOME", "HOME"] as const;
  let snap: Record<string, string | undefined>;
  beforeEach(() => {
    snap = {};
    for (const k of ENV) {
      snap[k] = process.env[k];
      delete process.env[k];
    }
    // PRX_CAS_ROOT scopes ALL domains under the temp (the driver GCs plans+submit).
    process.env.PRX_CAS_ROOT = mkdtempSync(join(tmpdir(), "prx-gc-cas-e2e-"));
  });
  afterEach(() => {
    for (const k of ENV) {
      if (snap[k] === undefined) delete process.env[k];
      else process.env[k] = snap[k];
    }
  });

  // Negative grace ⇒ future cutoff ⇒ even just-written orphans are reapable.
  const realCas = { listRefs, readBlob, listBlobs, deleteBlob, graceMs: -60_000 } as CasGcOps;

  test("plans: orphan reaped; the referenced envelope + body survive", async () => {
    const { sha: bodySha } = await writeBlob("the real plan body", { domain: "plans" });
    const { sha: envSha } = await writeBlob(envelopeJson(bodySha), { domain: "plans" });
    await setRef("GH-1:plan@approved", envSha, { domain: "plans" });
    const { sha: orphanSha } = await writeBlob("orphan", { domain: "plans" });
    const { out } = await markThenSweep(realCas);
    expect(out.reclaimed.map((f) => f.ref)).toContain(uri("plans", orphanSha));
    await expect(readBlob(orphanSha, { domain: "plans" })).rejects.toMatchObject({ code: "BLOB_NOT_FOUND" });
    expect((await readBlob(bodySha, { domain: "plans" })).toString()).toBe("the real plan body");
  });

  test("submit: orphan reaped; the referenced patch blob survives", async () => {
    const { sha: patchSha } = await writeBlob("the real patch diff", { domain: "submit" });
    const { sha: metaSha } = await writeBlob(submitArtifactJson(patchSha), { domain: "submit" });
    await setRef("GH-1:submit@ready", metaSha, { domain: "submit" });
    const { sha: orphanSha } = await writeBlob("orphan", { domain: "submit" });
    const { out } = await markThenSweep(realCas);
    expect(out.reclaimed.map((f) => f.ref)).toContain(uri("submit", orphanSha));
    await expect(readBlob(orphanSha, { domain: "submit" })).rejects.toMatchObject({ code: "BLOB_NOT_FOUND" });
    expect((await readBlob(patchSha, { domain: "submit" })).toString()).toBe("the real patch diff");
  });
});
