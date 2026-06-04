// GH-2269: the env-gated Signer factory. Gating is driven by an injected env
// reader so these tests never touch the real process environment.
// GH-2249 extends it with a stable signer, a matching verifier, and the
// enforcement flag.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  dssePae,
  DSSE_PAYLOAD_TYPE,
  generateEd25519Keypair,
} from "@bounded-systems/anchored-chain";

import {
  DEV_SIGNER_MODE,
  PROVENANCE_KEY_ENV,
  PROVENANCE_PUBKEY_ENV,
  REQUIRE_SIGNED_ENV,
  STABLE_KEY_PREFIX,
  requireSignedDerivations,
  resolveProvenanceSigner,
  resolveProvenanceVerifier,
} from "../signer.ts";

function envFrom(map: Record<string, string | undefined>) {
  return (key: string) => map[key];
}

// GH-2282: dev mode now persists a stable keypair under <XDG_STATE_HOME>/prx.
// Point it at a throwaway dir so these tests never touch the operator's real
// state dir, and so each `describe` gets a fresh dev identity.
let stateHome: string;
beforeAll(() => {
  stateHome = mkdtempSync(join(tmpdir(), "prx-signer-state-"));
});
afterAll(() => {
  rmSync(stateHome, { recursive: true, force: true });
});

/** A dev-mode env map rooted at the per-suite temp state dir. */
function devEnv(extra: Record<string, string | undefined> = {}) {
  return envFrom({
    [PROVENANCE_KEY_ENV]: DEV_SIGNER_MODE,
    XDG_STATE_HOME: stateHome,
    ...extra,
  });
}

/** A stable ed25519 keypair as the base64 raw seed + point a surface configures. */
function stableMaterial(): { seed: string; point: string } {
  const kp = generateEd25519Keypair();
  const seed = Buffer.from(
    (kp.privateKey.export({ format: "jwk" }) as { d: string }).d,
    "base64url",
  ).toString("base64");
  const point = Buffer.from(
    (kp.publicKey.export({ format: "jwk" }) as { x: string }).x,
    "base64url",
  ).toString("base64");
  return { seed, point };
}

describe("resolveProvenanceSigner — env-gated", () => {
  test("PRX_PROVENANCE_KEY=dev resolves an ed25519 signer", async () => {
    const signer = resolveProvenanceSigner(devEnv());
    expect(signer).not.toBeNull();

    // The dev signer must produce a real, verifiable ed25519 signature over the
    // DSSE PAE — proving it is a working Signer, not a stub.
    const pae = dssePae(DSSE_PAYLOAD_TYPE, new TextEncoder().encode("hello"));
    const sig = await signer!.sign(pae);
    expect(typeof sig.sig).toBe("string");
    expect((sig.keyid ?? "").length).toBeGreaterThan(0);
  });

  test("unset env resolves to null (prod default — Sigstore deferred)", () => {
    expect(resolveProvenanceSigner(envFrom({}))).toBeNull();
  });

  test("empty value resolves to null", () => {
    expect(
      resolveProvenanceSigner(envFrom({ [PROVENANCE_KEY_ENV]: "" })),
    ).toBeNull();
  });

  test("a non-dev value (e.g. future 'sigstore') resolves to null this PR", () => {
    expect(
      resolveProvenanceSigner(envFrom({ [PROVENANCE_KEY_ENV]: "sigstore" })),
    ).toBeNull();
  });

  test("GH-2282: dev resolutions share a STABLE persisted keypair (verifiable cross-process)", async () => {
    const a = resolveProvenanceSigner(devEnv())!;
    const b = resolveProvenanceSigner(devEnv())!;
    const pae = dssePae(DSSE_PAYLOAD_TYPE, new TextEncoder().encode("x"));
    const sigA = await a.sign(pae);
    const sigB = await b.sign(pae);
    // No longer ephemeral: the persisted dev identity is reused, so two
    // resolutions agree on keyid + signature — the precondition for a separate
    // process verifying a dev-emitted derivation.
    expect(sigA.keyid).toBe(sigB.keyid);
    expect(sigA.sig).toBe(sigB.sig);
  });

  test("GH-2282: a different state dir yields a different dev identity", async () => {
    const otherHome = mkdtempSync(join(tmpdir(), "prx-signer-other-"));
    try {
      const here = resolveProvenanceSigner(devEnv())!;
      const there = resolveProvenanceSigner(
        envFrom({ [PROVENANCE_KEY_ENV]: DEV_SIGNER_MODE, XDG_STATE_HOME: otherHome }),
      )!;
      const pae = dssePae(DSSE_PAYLOAD_TYPE, new TextEncoder().encode("x"));
      expect((await here.sign(pae)).keyid).not.toBe((await there.sign(pae)).keyid);
    } finally {
      rmSync(otherHome, { recursive: true, force: true });
    }
  });

  test("ed25519:<b64> resolves a STABLE signer (same keyid across calls)", async () => {
    const { seed } = stableMaterial();
    const a = resolveProvenanceSigner(
      envFrom({ [PROVENANCE_KEY_ENV]: `${STABLE_KEY_PREFIX}${seed}` }),
    )!;
    const b = resolveProvenanceSigner(
      envFrom({ [PROVENANCE_KEY_ENV]: `${STABLE_KEY_PREFIX}${seed}` }),
    )!;
    const pae = dssePae(DSSE_PAYLOAD_TYPE, new TextEncoder().encode("x"));
    const sigA = await a.sign(pae);
    const sigB = await b.sign(pae);
    // Stable, unlike dev: same material ⇒ same keyid ⇒ verifiable cross-process.
    expect(sigA.keyid).toBe(sigB.keyid);
    expect(sigA.sig).toBe(sigB.sig);
  });
});

describe("resolveProvenanceVerifier — env-gated", () => {
  test("unset / empty resolve to null", () => {
    expect(resolveProvenanceVerifier(envFrom({}))).toBeNull();
    expect(
      resolveProvenanceVerifier(envFrom({ [PROVENANCE_PUBKEY_ENV]: "" })),
    ).toBeNull();
  });

  test("the resolved verifier accepts a signature from the matching stable signer", async () => {
    const { seed, point } = stableMaterial();
    const signer = resolveProvenanceSigner(
      envFrom({ [PROVENANCE_KEY_ENV]: `${STABLE_KEY_PREFIX}${seed}` }),
    )!;
    const verifier = resolveProvenanceVerifier(
      envFrom({ [PROVENANCE_PUBKEY_ENV]: point }),
    )!;
    const pae = dssePae(DSSE_PAYLOAD_TYPE, new TextEncoder().encode("x"));
    expect(await verifier.verify(pae, await signer.sign(pae))).toBe(true);
  });

  test("a verifier for a different key rejects the signature", async () => {
    const a = stableMaterial();
    const b = stableMaterial();
    const signer = resolveProvenanceSigner(
      envFrom({ [PROVENANCE_KEY_ENV]: `${STABLE_KEY_PREFIX}${a.seed}` }),
    )!;
    const verifier = resolveProvenanceVerifier(
      envFrom({ [PROVENANCE_PUBKEY_ENV]: b.point }),
    )!;
    const pae = dssePae(DSSE_PAYLOAD_TYPE, new TextEncoder().encode("x"));
    expect(await verifier.verify(pae, await signer.sign(pae))).toBe(false);
  });

  test("GH-2282: single-key dev self-verifies (opt-out) — verifier auto-loads the persisted dev key with PUBKEY unset", async () => {
    // prx-1bo: per-actor is the default; this is the single-key escape hatch
    // (PRX_PROVENANCE_PER_ACTOR=off), where signer + verifier share the one
    // persisted dev key. (Per-actor dev self-verify is covered in actor-signer.test.)
    const env = devEnv({ PRX_PROVENANCE_PER_ACTOR: "off" });
    const signer = resolveProvenanceSigner(env)!;
    const verifier = resolveProvenanceVerifier(env)!;
    expect(verifier).not.toBeNull();
    const pae = dssePae(DSSE_PAYLOAD_TYPE, new TextEncoder().encode("x"));
    expect(await verifier.verify(pae, await signer.sign(pae))).toBe(true);
  });

  test("GH-2282: dev fallback does NOT fire for non-dev modes (no pubkey ⇒ null)", () => {
    expect(
      resolveProvenanceVerifier(
        envFrom({ [PROVENANCE_KEY_ENV]: "sigstore", XDG_STATE_HOME: stateHome }),
      ),
    ).toBeNull();
  });

  test("an ed25519:-prefixed pubkey is accepted (optional prefix)", async () => {
    const { seed, point } = stableMaterial();
    const signer = resolveProvenanceSigner(
      envFrom({ [PROVENANCE_KEY_ENV]: `${STABLE_KEY_PREFIX}${seed}` }),
    )!;
    const verifier = resolveProvenanceVerifier(
      envFrom({ [PROVENANCE_PUBKEY_ENV]: `${STABLE_KEY_PREFIX}${point}` }),
    )!;
    const pae = dssePae(DSSE_PAYLOAD_TYPE, new TextEncoder().encode("x"));
    expect(await verifier.verify(pae, await signer.sign(pae))).toBe(true);
  });
});

describe("requireSignedDerivations — enforcement flag", () => {
  test("truthy values turn enforcement on", () => {
    for (const v of ["1", "true", "TRUE", "on", "yes"]) {
      expect(
        requireSignedDerivations(envFrom({ [REQUIRE_SIGNED_ENV]: v })),
      ).toBe(true);
    }
  });

  test("unset / empty / non-truthy leave enforcement off (backward compatible)", () => {
    expect(requireSignedDerivations(envFrom({}))).toBe(false);
    expect(
      requireSignedDerivations(envFrom({ [REQUIRE_SIGNED_ENV]: "" })),
    ).toBe(false);
    expect(
      requireSignedDerivations(envFrom({ [REQUIRE_SIGNED_ENV]: "0" })),
    ).toBe(false);
    expect(
      requireSignedDerivations(envFrom({ [REQUIRE_SIGNED_ENV]: "off" })),
    ).toBe(false);
  });
});
