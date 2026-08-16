// L2 distribution: store a launch attestation in the CAS, resolve it via an L3's
// launch link (content-addressed). Uses a temp CAS root (PRX_CAS_ROOT).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { statement } from "@bounded-systems/ocap-provenance";
import { toSLSA } from "@bounded-systems/ocap-provenance/slsa";
import { canonicalJson } from "@bounded-systems/ocap-provenance/attestation";

import {
  launchDigestOf,
  resolveLaunchAttestationFromCas,
  storeLaunchAttestation,
} from "../../src/provenance/launch-store.ts";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

const l2slsa = toSLSA(
  statement([{ name: "box", digest: { sha256: "e".repeat(64) } }], {
    level: "launch",
    producer: { kind: "nix-flake", id: "launcher" },
    capabilities: { workcell: "claude-box", manifestDigest: { sha256: "e".repeat(64) } },
  }),
);
const l2 = { statement: l2slsa, signature: "sig", keyId: "launcher" };

function l3LinkingDigest(d: string) {
  const slsa = toSLSA(
    statement([{ name: "c".repeat(40), digest: { gitCommit: "c".repeat(40) } }], {
      level: "write",
      producer: { kind: "keeperd", id: "keeper" },
      capabilities: { workcell: "claude-box", manifestDigest: { sha256: "e".repeat(64) } },
      links: [{ level: "launch", digest: { sha256: d } }],
    }),
  );
  return { statement: slsa, signature: "s", keyId: "k" };
}

describe("launch-store (CAS distribution)", () => {
  let root = "";
  let prev: string | undefined;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "prx-launch-cas-"));
    prev = process.env.PRX_CAS_ROOT;
    process.env.PRX_CAS_ROOT = root;
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.PRX_CAS_ROOT;
    else process.env.PRX_CAS_ROOT = prev;
    rmSync(root, { recursive: true, force: true });
  });

  test("stores an L2 and resolves it via an L3's launch link", async () => {
    const digest = await storeLaunchAttestation(l2);
    expect(digest).toBe(sha256(canonicalJson(l2slsa)));
    expect(launchDigestOf(l2)).toBe(digest);

    const got = await resolveLaunchAttestationFromCas(l3LinkingDigest(digest));
    expect(got).not.toBeNull();
    expect(canonicalJson(got!.statement)).toBe(canonicalJson(l2.statement));
    expect(got!.signature).toBe("sig");
  });

  test("returns null when the L3 has no launch link", async () => {
    const noLink = toSLSA(
      statement([{ name: "c", digest: { gitCommit: "c" } }], {
        level: "write",
        producer: { kind: "keeperd", id: "k" },
      }),
    );
    expect(await resolveLaunchAttestationFromCas({ statement: noLink, signature: "s" })).toBeNull();
  });

  test("returns null when the linked L2 isn't stored", async () => {
    expect(await resolveLaunchAttestationFromCas(l3LinkingDigest("f".repeat(64)))).toBeNull();
  });
});
