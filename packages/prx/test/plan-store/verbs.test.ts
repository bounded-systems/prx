import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getRef, PlanStoreError, readBlob, setRef, writeBlob } from "../../src/plan-store/cas.ts";
import {
  PlanRefNotFound,
  refName,
  runPlanLoad,
  runPlanSave,
  runPlanShow,
} from "../../src/plan-store/verbs.ts";
import { parseEnvelope, serializeEnvelope } from "../../src/plan-store/envelope.ts";

const ENV_KEYS = [
  "PRX_PLAN_STORE",
  "PRX_AI_HOME_ROOT",
  "BAKED_AI_HOME_ROOT",
  "PRX_OPERATOR_CONFIG_ROOT",
  "BAKED_OPERATOR_CONFIG_ROOT",
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

describe("plan-store/verbs", () => {
  let envSnap: EnvSnapshot;

  beforeEach(() => {
    envSnap = snapshotEnv();
    const storeRoot = mkdtempSync(join(tmpdir(), "prx-plan-verbs-"));
    for (const k of ENV_KEYS) {
      delete process.env[k];
    }
    process.env.PRX_PLAN_STORE = storeRoot;
  });

  afterEach(() => {
    restoreEnv(envSnap);
  });

  test("1. refName composes <UoW>:plan@<slot>", () => {
    expect(refName("GH-1173", "draft")).toBe("GH-1173:plan@draft");
    expect(refName("GH-1173", "approved")).toBe("GH-1173:plan@approved");
  });

  test("2. save→load roundtrip returns identical bytes", async () => {
    const body = "# Plan body\n\nstep one\n";
    const { sha, ref } = await runPlanSave({
      unit: "GH-1173",
      slot: "draft",
      content: body,
      // GH-1277: this test exercises CAS roundtrip, not the shape gate.
      skipValidate: true,
    });
    expect(ref).toBe("GH-1173:plan@draft");
    expect(await getRef(ref)).toBe(sha);
    const loaded = await runPlanLoad({ unit: "GH-1173", slot: "draft" });
    expect(loaded.sha).toBe(sha);
    expect(loaded.content.toString("utf8")).toBe(body);
    expect(loaded.fellBackToDraft).toBe(false);
    expect(loaded.slot).toBe("draft");
  });

  test("prx-bs4: a JSON PlanArtifact body validates via the schema branch of the unified contract", async () => {
    const validJson = JSON.stringify({
      problem: "p",
      scope: "s",
      approach: "a",
      changes: [],
      risks: [],
      acceptance: ["done"],
    });
    const ok = await runPlanSave({ unit: "GH-9a", slot: "draft", content: validJson });
    expect(ok.validated_ok).toBe(true);
    expect(ok.diagnostics).toEqual([]);

    // Empty scope → the schema rejects it (no `## Scope` markdown grep involved).
    const noScope = JSON.stringify({
      problem: "p",
      scope: "",
      approach: "a",
      changes: [],
      risks: [],
      acceptance: ["done"],
    });
    const bad = await runPlanSave({ unit: "GH-9b", slot: "draft", content: noScope });
    expect(bad.validated_ok).toBe(false);
    expect(bad.diagnostics.map((d) => d.code)).toContain("empty-scope");
  });

  test("3. load approved with fallback returns draft when approved missing", async () => {
    await runPlanSave({
      unit: "GH-1173",
      slot: "draft",
      content: "draft body",
      skipValidate: true,
    });
    const loaded = await runPlanLoad({
      unit: "GH-1173",
      slot: "approved",
      fallbackToDraft: true,
    });
    expect(loaded.slot).toBe("draft");
    expect(loaded.fellBackToDraft).toBe(true);
    expect(loaded.content.toString("utf8")).toBe("draft body");
  });

  test("4. load approved without fallback throws when approved missing", async () => {
    await runPlanSave({
      unit: "GH-1173",
      slot: "draft",
      content: "x",
      skipValidate: true,
    });
    let caught: unknown = null;
    try {
      await runPlanLoad({ unit: "GH-1173", slot: "approved" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PlanRefNotFound);
    expect((caught as PlanRefNotFound).slot).toBe("approved");
  });

  test("5. show resolves approved first, falls back to draft", async () => {
    await runPlanSave({
      unit: "GH-1173",
      slot: "draft",
      content: "D",
      skipValidate: true,
    });
    const draftShown = await runPlanShow({ unit: "GH-1173" });
    expect(draftShown.slot).toBe("draft");
    expect(draftShown.body.toString("utf8")).toBe("D");

    await runPlanSave({
      unit: "GH-1173",
      slot: "approved",
      content: "A",
      skipValidate: true,
    });
    const approvedShown = await runPlanShow({ unit: "GH-1173" });
    expect(approvedShown.slot).toBe("approved");
    expect(approvedShown.body.toString("utf8")).toBe("A");
    expect(approvedShown.size).toBe(1);
  });

  test("5a. show with explicit --slot draft pins to draft (no approved fallback path)", async () => {
    // GH-1227: --slot disables fallback so operators can introspect a specific
    // ref. With both slots present, explicit draft must return the draft body.
    await runPlanSave({
      unit: "GH-1173",
      slot: "draft",
      content: "D",
      skipValidate: true,
    });
    await runPlanSave({
      unit: "GH-1173",
      slot: "approved",
      content: "A",
      skipValidate: true,
    });
    const shown = await runPlanShow({ unit: "GH-1173", slot: "draft" });
    expect(shown.slot).toBe("draft");
    expect(shown.body.toString("utf8")).toBe("D");
  });

  test("5b. show with explicit --slot approved skips draft when approved missing", async () => {
    // GH-1227: explicit --slot approved must NOT fall back to draft. With only
    // a draft saved, the call must throw PlanRefNotFound on slot=approved.
    await runPlanSave({
      unit: "GH-1173",
      slot: "draft",
      content: "only-draft",
      skipValidate: true,
    });
    let caught: unknown;
    try {
      await runPlanShow({ unit: "GH-1173", slot: "approved" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PlanRefNotFound);
    expect((caught as PlanRefNotFound).slot).toBe("approved");
  });

  test("6. slot independence: saving approved leaves draft blob intact (CAS immutability)", async () => {
    const draft = await runPlanSave({
      unit: "GH-1173",
      slot: "draft",
      content: "ORIGINAL DRAFT",
      skipValidate: true,
    });
    await runPlanSave({
      unit: "GH-1173",
      slot: "approved",
      content: "DIFFERENT APPROVED",
      skipValidate: true,
    });
    const reloaded = await runPlanLoad({ unit: "GH-1173", slot: "draft" });
    expect(reloaded.sha).toBe(draft.sha);
    expect(reloaded.content.toString("utf8")).toBe("ORIGINAL DRAFT");
  });

  // GH-2028: persist-on-failure. The producer ALWAYS writes the body; the
  // content-validation verdict rides in the envelope (validated_ok=false +
  // diagnostics). Refusal moves to the consumer. This is the GH-2009 / GH-1473
  // regression — a shape-failing body must survive, never silently vanish.
  test("8. runPlanSave persists body + validated_ok=false when no `## Scope`", async () => {
    const body = "# Plan\n\n## Goals\n\nDo a thing.\n";
    const result = await runPlanSave({ unit: "GH-1277", slot: "draft", content: body });
    expect(result.validated_ok).toBe(false);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.code).toBe("no-scope");
    expect(result.diagnostics[0]!.path).toBe("## Scope");
    expect(result.diagnostics[0]!.message).toContain("GH-1277");
    // The ref + body persisted — the regression captured as a test.
    expect(await getRef(refName("GH-1277", "draft"))).toBe(result.sha);
    expect(result.envelope_sha).toBe(result.sha);
    const loaded = await runPlanLoad({ unit: "GH-1277", slot: "draft" });
    expect(loaded.content.toString("utf8")).toBe(body);
    expect(loaded.validated_ok).toBe(false);
    expect(loaded.diagnostics[0]!.code).toBe("no-scope");
  });

  test("9. runPlanSave persists body + validated_ok=false when `## Scope` is empty", async () => {
    const body = "## Scope\n\n<!-- TODO -->\n\n## Next\n";
    const result = await runPlanSave({ unit: "GH-1277", slot: "draft", content: body });
    expect(result.validated_ok).toBe(false);
    expect(result.diagnostics[0]!.code).toBe("empty-scope");
    const loaded = await runPlanLoad({ unit: "GH-1277", slot: "draft" });
    expect(loaded.content.toString("utf8")).toBe(body);
    expect(loaded.validated_ok).toBe(false);
  });

  test("10. runPlanSave persists a body with non-empty `## Scope` (validated_ok=true)", async () => {
    const body = "# Plan\n\n## Scope\n\n- Real scope.\n";
    const result = await runPlanSave({
      unit: "GH-1277",
      slot: "draft",
      content: body,
    });
    expect(result.ref).toBe("GH-1277:plan@draft");
    expect(await getRef(result.ref)).toBe(result.sha);
    expect(result.validated_ok).toBe(true);
    expect(result.diagnostics).toHaveLength(0);
    const loaded = await runPlanLoad({ unit: "GH-1277", slot: "draft" });
    expect(loaded.validated_ok).toBe(true);
  });

  test("11. runPlanSave with skipValidate=true forces validated_ok=true on a malformed body", async () => {
    const body = "# Plan\n\n## Goals\n\nNo Scope here.\n";
    const result = await runPlanSave({
      unit: "GH-1277",
      slot: "draft",
      content: body,
      skipValidate: true,
    });
    expect(await getRef(result.ref)).toBe(result.sha);
    // skipValidate forces consumability; diagnostics are still recorded.
    expect(result.validated_ok).toBe(true);
    expect(result.diagnostics[0]!.code).toBe("no-scope");
    const loaded = await runPlanLoad({ unit: "GH-1277", slot: "draft" });
    expect(loaded.content.toString("utf8")).toBe(body);
    expect(loaded.validated_ok).toBe(true);
  });

  // GH-2028: lazy migration. A legacy bare-sha ref points straight at a raw
  // body blob (pre-envelope). Reads synthesize validated_ok=true; the next save
  // upgrades the ref to envelope format with no on-disk rewrite of the body.
  test("12. legacy bare-sha ref reads as validated_ok=true, upgrades on next save", async () => {
    const legacyBody = "# Legacy plan\n\n## Scope\n\n- pre-envelope.\n";
    const { sha: bodySha } = await writeBlob(legacyBody);
    await setRef(refName("GH-2028", "draft"), bodySha);

    const shown = await runPlanShow({ unit: "GH-2028", slot: "draft" });
    expect(shown.body.toString("utf8")).toBe(legacyBody);
    expect(shown.validated_ok).toBe(true);
    expect(shown.diagnostics).toHaveLength(0);
    // The ref still points at the raw body blob (no rewrite on read).
    expect(await getRef(refName("GH-2028", "draft"))).toBe(bodySha);

    const upgraded = await runPlanSave({
      unit: "GH-2028",
      slot: "draft",
      content: legacyBody,
    });
    // Now the ref points at an envelope blob referencing the body.
    expect(upgraded.envelope_sha).toBe(upgraded.sha);
    expect(upgraded.body_sha).toBe(bodySha);
    const refTarget = await getRef(refName("GH-2028", "draft"));
    expect(refTarget).toBe(upgraded.envelope_sha);
    const envelope = parseEnvelope(await readBlob(refTarget!));
    expect(envelope).not.toBeNull();
    expect(envelope!.body_sha).toBe(bodySha);
  });

  test("7. E2E (acceptance): planner saves → executor loads bytes-identical", async () => {
    const planBody = Buffer.from([0x23, 0x20, 0x70, 0x6c, 0x61, 0x6e, 0x0a, 0x01, 0xff]);
    const { sha } = await runPlanSave({
      unit: "GH-1173",
      slot: "approved",
      content: planBody,
      skipValidate: true,
    });
    const loaded = await runPlanLoad({
      unit: "GH-1173",
      slot: "approved",
      fallbackToDraft: true,
    });
    expect(loaded.sha).toBe(sha);
    expect(loaded.content.equals(planBody)).toBe(true);
    expect(loaded.fellBackToDraft).toBe(false);
  });

  // GH-2028 follow-up (GH-2288): a *valid* envelope whose body_sha does not
  // resolve to a blob (e.g. a GC'd or hand-deleted body) must fail loud with
  // BLOB_NOT_FOUND. This is a deliberate divergence from the parse-ambiguity
  // guard: a malformed/overlapping blob parses to null and is treated as a
  // legacy body, but a well-formed envelope pointing at a missing body is NOT
  // re-rendered as a body — it surfaces the error. This characterization test
  // pins that behavior so it cannot be silently "fixed" into a body fallback.
  test("envelope with a missing body_sha fails loud (BLOB_NOT_FOUND), never a body fallback", async () => {
    // A schema-valid envelope: schema_version 1, well-formed sha256 body_sha,
    // verdict + diagnostics. The body_sha is all-zeros — never written to CAS.
    const missingBodySha = `sha256:${"0".repeat(64)}`;
    const envelopeBlob = serializeEnvelope({
      schema_version: 1,
      body_sha: missingBodySha,
      validated_ok: true,
      diagnostics: [],
    });
    // Sanity: the blob really is a well-formed envelope (not the null branch).
    expect(parseEnvelope(envelopeBlob)).not.toBeNull();

    const { sha: envelopeSha } = await writeBlob(envelopeBlob);
    await setRef(refName("GH-2288", "draft"), envelopeSha);

    // Both read verbs resolve through resolveBody → readBlob(body_sha) → throw.
    // Assert the typed code (not an incidental throw), and that it names the
    // missing *body* — the envelope blob itself resolved fine.
    let caughtLoad: unknown = null;
    try {
      await runPlanLoad({ unit: "GH-2288", slot: "draft" });
    } catch (err) {
      caughtLoad = err;
    }
    expect(caughtLoad).toBeInstanceOf(PlanStoreError);
    expect((caughtLoad as PlanStoreError).code).toBe("BLOB_NOT_FOUND");
    expect((caughtLoad as PlanStoreError).message).toContain(missingBodySha);

    let caughtShow: unknown = null;
    try {
      await runPlanShow({ unit: "GH-2288", slot: "draft" });
    } catch (err) {
      caughtShow = err;
    }
    expect(caughtShow).toBeInstanceOf(PlanStoreError);
    expect((caughtShow as PlanStoreError).code).toBe("BLOB_NOT_FOUND");
  });
});
