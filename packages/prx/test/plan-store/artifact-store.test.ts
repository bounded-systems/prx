// GH-2349 (spike GH-2348 .1): shared CAS artifact kernel — ref convention +
// writeBlob→setRef pairing reused by plan@ / submit@ / (future) implement@.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getRef, readBlob } from "../../src/plan-store/cas.ts";
import {
  artifactRef,
  putArtifact,
} from "../../src/plan-store/artifact-store.ts";

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

describe("artifactRef (GH-2349)", () => {
  test("builds the canonical <unit>:<kind>@<slot> ref", () => {
    expect(artifactRef("GH-1", "plan", "draft")).toBe("GH-1:plan@draft");
    expect(artifactRef("GH-2", "submit", "ready")).toBe("GH-2:submit@ready");
  });
});

describe("putArtifact (GH-2349)", () => {
  let envSnap: EnvSnapshot;

  beforeEach(() => {
    envSnap = snapshotEnv();
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.PRX_CAS_ROOT = mkdtempSync(join(tmpdir(), "prx-artifact-store-"));
  });
  afterEach(() => restoreEnv(envSnap));

  test("writes the metadata blob and advances the ref to it (default domain)", async () => {
    const ref = artifactRef("GH-1", "plan", "draft");
    const { ref: outRef, sha } = await putArtifact(ref, "hello-metadata");
    expect(outRef).toBe(ref);
    expect(sha).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await getRef(ref)).toBe(sha);
    expect((await readBlob(sha)).toString("utf8")).toBe("hello-metadata");
  });

  test("domain-scoped: a submit-domain ref does not resolve in the default domain", async () => {
    const ref = artifactRef("GH-2", "submit", "ready");
    const { sha } = await putArtifact(ref, "submit-meta", { domain: "submit" });
    expect(await getRef(ref, { domain: "submit" })).toBe(sha);
    expect(await getRef(ref)).toBeNull();
  });
});
