// GH-352: a `scout read` under a signer records a signed, content-addressed
// `scout/read/v1` derivation — `inputs { source } → output { envelope }`,
// signed. The signed counterpart of scout's unsigned bespoke record, sharing
// one chain with the CI derivations (both bucket A: sha256 content addressing).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ed25519Signer,
  ed25519Verifier,
  generateEd25519Keypair,
  type Digest,
} from "@bounded-systems/anchored-chain";
import { openAnchoredChain } from "@bounded-systems/anchored-chain-sqlite";
import { sha256BareHex } from "@bounded-systems/cas";
import { formatScoutReadJson, type ScoutReadResult } from "@bounded-systems/scout";

import { type AttestDeps } from "../../src/provenance/attest.ts";
import { decodeSlsaStatement, verifySlsaDerivation } from "../../src/provenance/verify.ts";
import {
  attestScoutRead,
  SCOUT_READ_BUILD_TYPE,
  SCOUT_SIGNING_REQUIRED_MESSAGE,
} from "../../src/pr-state/scout-attest.ts";
import { ciSigningDecision } from "../../src/pr-state/ci-attest.ts";

const RESULT: ScoutReadResult = {
  path: "packages/prx/src/pr-state/cli.ts",
  sha256: "a".repeat(64),
  bytes: 1234,
  lines: 56,
  truncated: false,
  content: "the file content",
};

let dir: string;
let chain: ReturnType<typeof openAnchoredChain>;
let deps: AttestDeps;
let verifier: ReturnType<typeof ed25519Verifier>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "scout-attest-"));
  chain = openAnchoredChain(join(dir, "ledger.sqlite"));
  const kp = generateEd25519Keypair();
  deps = { signer: ed25519Signer(kp.privateKey, kp.keyid), store: chain.derivations, now: () => 1000 };
  verifier = ed25519Verifier(kp.publicKey);
});

afterEach(() => {
  chain.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("attestScoutRead — signed scout/read/v1 (GH-352)", () => {
  test("signed, verifiable; source→envelope content addressing", async () => {
    const d = await attestScoutRead(deps, RESULT);

    expect(await verifySlsaDerivation(d, verifier)).toBe(true);
    expect(decodeSlsaStatement(d.envelope!).predicate.buildDefinition.buildType).toBe(
      SCOUT_READ_BUILD_TYPE,
    );
    // Input is the file's content digest (bucket A) — `invalidate` keys on it.
    expect(String(d.manifest.inputs.source)).toBe(`sha256:${RESULT.sha256}`);
    // Output is the emitted envelope's digest (the scout:// handle's content).
    const envelope = sha256BareHex(formatScoutReadJson(RESULT));
    expect(String(d.manifest.outputs.envelope)).toBe(`sha256:${envelope}`);
    expect(d.manifest.params.path).toBe(RESULT.path);
  });

  test("idempotent: re-recording the same read adds no duplicate", async () => {
    const first = await attestScoutRead(deps, RESULT);
    const second = await attestScoutRead(deps, RESULT);
    expect(second.derivationId).toBe(first.derivationId);
    const byOutput = await chain.derivations.derivationsByOutput(
      first.manifest.outputs.envelope as Digest,
    );
    expect(byOutput).toHaveLength(1);
  });

  // Bucket A: the read is a chain node. "Which reads consumed this file?" is a
  // reverse lineage query over the source content digest.
  test("invalidate.descendants finds the reads that consumed a file", async () => {
    const d = await attestScoutRead(deps, RESULT);
    const hit = await chain.invalidate.descendants(`sha256:${RESULT.sha256}` as Digest);
    expect(hit).toContain(d.derivationId);
  });

  test("a different file content yields a different derivation (source binds it)", async () => {
    const a = await attestScoutRead(deps, RESULT);
    const b = await attestScoutRead(deps, { ...RESULT, sha256: "b".repeat(64) });
    expect(a.derivationId).not.toBe(b.derivationId);
  });
});

describe("scout read signing gate — fail-closed in a signing context (GH-352)", () => {
  test("no ledger in scope ⇒ skip (a bare read outside a work-unit is unaffected)", () => {
    expect(ciSigningDecision(undefined, false)).toBe("skip");
  });

  test("ledger in scope but no signer ⇒ fail (in-pipeline read must be signed)", () => {
    expect(ciSigningDecision("/wu/ledger.sqlite", false)).toBe("fail");
  });

  test("ledger + signer ⇒ sign", () => {
    expect(ciSigningDecision("/wu/ledger.sqlite", true)).toBe("sign");
  });

  test("the fail message is actionable (points at the setup/status commands)", () => {
    expect(SCOUT_SIGNING_REQUIRED_MESSAGE).toContain("prx provenance setup");
    expect(SCOUT_SIGNING_REQUIRED_MESSAGE).toContain("prx provenance status");
  });
});
