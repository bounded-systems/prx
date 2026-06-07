// GH-1900: SubmitArtifactSchema + CAS helpers.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getRef } from "../../src/plan-store/cas.ts";
import {
  parseSubmitRef,
  readSubmitArtifact,
  SubmitArtifactSchema,
  SUBMIT_DOMAIN,
  submitRefFor,
  writeSubmitArtifact,
  writeSubmitPatchBlob,
  type SubmitArtifact,
} from "../../src/submit/artifact.schema.ts";

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
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snap: EnvSnapshot): void {
  for (const k of ENV_KEYS) {
    const v = snap[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const HEX40 = "1234567890abcdef1234567890abcdef12345678";
const HEX64 = "0".repeat(64);

function validArtifact(overrides: Partial<SubmitArtifact> = {}): SubmitArtifact {
  return {
    workUnitId: "GH-1900",
    baseRef: "main",
    baseSha: HEX40,
    tree: { sha: HEX40 },
    patch: { sha: `sha256:${HEX64}`, bytes: 0 },
    summary: "Implement submit-artifact handoff",
    createdAt: "2026-05-17T00:00:00.000Z",
    ...overrides,
  };
}

describe("SubmitArtifactSchema", () => {
  test("accepts a well-formed artifact", () => {
    const result = SubmitArtifactSchema.safeParse(validArtifact());
    expect(result.success).toBe(true);
  });

  // prx-gr1: beads / non-GH canonical ids are valid work units now.
  test("accepts a beads canonical workUnitId", () => {
    const result = SubmitArtifactSchema.safeParse(
      validArtifact({ workUnitId: "prx-2c4" as unknown as string }),
    );
    expect(result.success).toBe(true);
  });

  test("rejects a workUnitId with ref delimiters", () => {
    const result = SubmitArtifactSchema.safeParse(
      validArtifact({ workUnitId: "has:colon" as unknown as string }),
    );
    expect(result.success).toBe(false);
  });

  test("rejects bad sha shapes", () => {
    const cases: Array<Partial<SubmitArtifact>> = [
      { baseSha: "not-hex" },
      { tree: { sha: "abc" } },
      { patch: { sha: "sha1:abcd", bytes: 0 } },
    ];
    for (const overrides of cases) {
      const result = SubmitArtifactSchema.safeParse(validArtifact(overrides));
      expect(result.success).toBe(false);
    }
  });

  test("rejects non-integer or negative patch.bytes", () => {
    for (const bytes of [-1, 1.5, Number.NaN]) {
      const result = SubmitArtifactSchema.safeParse(
        validArtifact({ patch: { sha: `sha256:${HEX64}`, bytes } }),
      );
      expect(result.success).toBe(false);
    }
  });

  test("rejects oversize summary", () => {
    const result = SubmitArtifactSchema.safeParse(
      validArtifact({ summary: "x".repeat(501) }),
    );
    expect(result.success).toBe(false);
  });

  test("rejects non-datetime createdAt", () => {
    const result = SubmitArtifactSchema.safeParse(
      validArtifact({ createdAt: "yesterday" }),
    );
    expect(result.success).toBe(false);
  });
});

describe("submitRefFor / parseSubmitRef", () => {
  test("round-trips draft/ready/published slots", () => {
    for (const slot of ["draft", "ready", "published"] as const) {
      const ref = submitRefFor("GH-1900", slot);
      expect(ref).toBe(`GH-1900:submit@${slot}`);
      expect(parseSubmitRef(ref)).toEqual({ workUnitId: "GH-1900", slot });
    }
  });

  // prx-gr1: submit is no longer GitHub-only — any canonical work-unit id
  // (beads `prx-xxx`, `bd-xyz`; notion `PROJECT-x`; github `GH-N`) round-trips,
  // so beads units can reach a PR. Only refs that break the `<unit>:submit@<slot>`
  // shape (delimiters in the unit, bad slot) reject.
  test("accepts beads / non-GH canonical ids", () => {
    for (const unit of ["prx-2c4", "bd-xyz", "PROJECT-6637"]) {
      const ref = submitRefFor(unit, "draft");
      expect(ref).toBe(`${unit}:submit@draft`);
      expect(parseSubmitRef(ref)).toEqual({ workUnitId: unit, slot: "draft" });
    }
  });

  test("rejects malformed refs", () => {
    expect(() => submitRefFor("has:colon", "draft")).toThrow();
    expect(() => submitRefFor("nodelimiter", "draft")).toThrow();
    expect(() => submitRefFor("", "draft")).toThrow();
    expect(() => parseSubmitRef("GH-1:submit@bogus")).toThrow();
    expect(() => parseSubmitRef("GH-1:notsubmit@draft")).toThrow();
  });
});

describe("writeSubmitArtifact / readSubmitArtifact (CAS round-trip)", () => {
  let envSnap: EnvSnapshot;
  let casRoot: string;

  beforeEach(() => {
    envSnap = snapshotEnv();
    casRoot = mkdtempSync(join(tmpdir(), "prx-submit-cas-"));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.PRX_CAS_ROOT = casRoot;
  });

  afterEach(() => {
    restoreEnv(envSnap);
  });

  test("writes to submit domain, advances ref, reads back identical artifact", async () => {
    const artifact = validArtifact();
    const { ref, sha } = await writeSubmitArtifact({ artifact, slot: "ready" });
    expect(ref).toBe("GH-1900:submit@ready");
    expect(sha).toMatch(/^sha256:[0-9a-f]{64}$/);

    const stored = await getRef(ref, { domain: SUBMIT_DOMAIN });
    expect(stored).toBe(sha);

    const round = await readSubmitArtifact({ sha });
    expect(round).toEqual(artifact);
  });

  test("patch blob can be written separately and referenced by metadata", async () => {
    const patch = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n";
    const { sha: patchSha, bytes } = await writeSubmitPatchBlob(patch);
    expect(patchSha).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(bytes).toBe(Buffer.byteLength(patch, "utf8"));

    const artifact = validArtifact({ patch: { sha: patchSha, bytes } });
    const { sha: metaSha } = await writeSubmitArtifact({ artifact, slot: "draft" });
    const round = await readSubmitArtifact({ sha: metaSha });
    expect(round.patch).toEqual({ sha: patchSha, bytes });
  });

  test("overwriting the draft slot does not stomp the ready slot", async () => {
    const draft = validArtifact({ summary: "first draft" });
    const ready = validArtifact({ summary: "ready cut" });
    const { ref: draftRef } = await writeSubmitArtifact({ artifact: draft, slot: "draft" });
    const { ref: readyRef, sha: readySha } = await writeSubmitArtifact({
      artifact: ready,
      slot: "ready",
    });

    expect(draftRef).toBe("GH-1900:submit@draft");
    expect(readyRef).toBe("GH-1900:submit@ready");

    const readyStored = await getRef(readyRef, { domain: SUBMIT_DOMAIN });
    expect(readyStored).toBe(readySha);

    const drafted = await writeSubmitArtifact({
      artifact: validArtifact({ summary: "second draft" }),
      slot: "draft",
    });
    expect(drafted.ref).toBe(draftRef);
    // Ready ref is untouched.
    expect(await getRef(readyRef, { domain: SUBMIT_DOMAIN })).toBe(readySha);
  });

  test("readSubmitArtifact requires a sha", async () => {
    await expect(readSubmitArtifact({})).rejects.toThrow(/sha is required/);
  });
});
