// GH-352: a green `prx ci` records a signed, content-addressed CI derivation
// per phase — `inputs { tree, lock, toolchain } → output { commit }`, signed.
// These tests ARE the contract: the record is signed + merge-guard-verifiable
// (bucket B), AND it is a chain node whose `isStale`/`invalidate` work over the
// validated tree (bucket A) — the unification the checks/v1-only emission lacked.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ed25519Signer,
  ed25519Verifier,
  generateEd25519Keypair,
} from "@bounded-systems/anchored-chain";
import { openAnchoredChain } from "@bounded-systems/anchored-chain-sqlite";
import { getAuditRuntimeContext, setAuditRuntimeContext } from "@bounded-systems/audit-context";

import { type AttestDeps } from "../../src/provenance/attest.ts";
import { decodeSlsaStatement, verifySlsaDerivation } from "../../src/provenance/verify.ts";
import {
  attestCiPhases,
  currentCiRefs,
  CI_ATTEST_SURFACE,
  CI_PHASE_BUILD_TYPE,
  resolveCiInputs,
} from "../../src/pr-state/ci-attest.ts";
import { CI_PHASES } from "../../src/pr-state/local-ci.ts";

const COMMIT = "1234567890abcdef1234567890abcdef12345678";
const INPUTS = resolveCiInputs({ treeOid: "abc123", lock: "lockfile-bytes", toolchain: "bun 1.3.11" });

let dir: string;
let chain: ReturnType<typeof openAnchoredChain>;
let deps: AttestDeps;
let verifier: ReturnType<typeof ed25519Verifier>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ci-attest-"));
  chain = openAnchoredChain(join(dir, "ledger.sqlite"));
  const kp = generateEd25519Keypair();
  deps = { signer: ed25519Signer(kp.privateKey, kp.keyid), store: chain.derivations, now: () => 1000 };
  verifier = ed25519Verifier(kp.publicKey);
});

afterEach(() => {
  chain.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("attestCiPhases — signed + content-addressed CI derivation (GH-352)", () => {
  test("each phase: signed, commit-subject, and content inputs (tree/lock/toolchain)", async () => {
    const phases = [...CI_PHASES];
    const recorded = await attestCiPhases(deps, INPUTS, COMMIT, phases);

    expect(recorded).toHaveLength(phases.length);
    for (const d of recorded) {
      // Bucket B: signed envelope verifies, build type is ci/phase/v1.
      expect(await verifySlsaDerivation(d, verifier)).toBe(true);
      expect(decodeSlsaStatement(d.envelope!).predicate.buildDefinition.buildType).toBe(
        CI_PHASE_BUILD_TYPE,
      );
      // Merge-guard compatibility: the commit is the output it reverse-looks-up.
      expect(String(d.manifest.outputs.commit)).toBe(`gitCommit:${COMMIT}`);
      // Bucket A: the validated tree is carried as sha256 inputs — NOT empty.
      expect(String(d.manifest.inputs.tree)).toBe(`sha256:${INPUTS.tree}`);
      expect(String(d.manifest.inputs.lock)).toBe(`sha256:${INPUTS.lock}`);
      expect(String(d.manifest.inputs.toolchain)).toBe(`sha256:${INPUTS.toolchain}`);
      expect(d.manifest.params.surface).toBe(CI_ATTEST_SURFACE);
    }
  });

  test("distinct phases → distinct derivation ids (phase feeds the digest)", async () => {
    const recorded = await attestCiPhases(deps, INPUTS, COMMIT, ["typecheck", "test"]);
    expect(new Set(recorded.map((d) => d.derivationId as string)).size).toBe(2);
  });

  test("idempotent: re-recording the same (inputs, commit, phase) adds no duplicate", async () => {
    const first = await attestCiPhases(deps, INPUTS, COMMIT, ["typecheck"]);
    const second = await attestCiPhases(deps, INPUTS, COMMIT, ["typecheck"]);
    expect(second[0]!.derivationId).toBe(first[0]!.derivationId);
    const byCommit = await chain.derivations.derivationsByOutput(`gitCommit:${COMMIT}` as never);
    expect(byCommit).toHaveLength(1);
  });

  // The bucket-A capability the whole change is about: the recorded green is a
  // chain node whose freshness/invalidation reason over the validated tree.
  test("isStale: fresh while the tree matches, stale once HEAD's tree moves", async () => {
    const [d] = await attestCiPhases(deps, INPUTS, COMMIT, ["test"]);

    expect(await chain.lineage.isStale(d!.derivationId, currentCiRefs(INPUTS))).toBe(false);

    const movedTree = resolveCiInputs({ treeOid: "def456", lock: "lockfile-bytes", toolchain: "bun 1.3.11" });
    expect(await chain.lineage.isStale(d!.derivationId, currentCiRefs(movedTree))).toBe(true);
  });

  test("invalidate.descendants finds the CI work that validated a given tree", async () => {
    const [d] = await attestCiPhases(deps, INPUTS, COMMIT, ["test"]);
    const hit = await chain.invalidate.descendants(`sha256:${INPUTS.tree}` as never);
    expect(hit).toContain(d!.derivationId);
  });

  // Attribution follows the dispatch *source* model: the verdict is signed with
  // the ambient actor's authority (the `builder.id`), NOT a pinned `local_ci`
  // tool actor. A direct run is sourced from the human (`claude-code` default);
  // a leg-dispatched run carries that leg's actor.
  test("builder.id is the ambient source authority, not a pinned tool actor", async () => {
    const before = getAuditRuntimeContext();
    try {
      // Direct call ⇒ the human/agent default authority.
      setAuditRuntimeContext({ actor: "claude-code", verb: "ci" });
      const [direct] = await attestCiPhases(deps, INPUTS, COMMIT, ["test"]);
      expect(decodeSlsaStatement(direct!.envelope!).predicate.runDetails.builder.id).toBe(
        "prx://claude-code/ci",
      );

      // A leg-dispatched run ⇒ that leg's authority (here `implement`).
      setAuditRuntimeContext({ actor: "implement", verb: "ci" });
      const [leg] = await attestCiPhases(deps, INPUTS, "a".repeat(40), ["test"]);
      expect(decodeSlsaStatement(leg!.envelope!).predicate.runDetails.builder.id).toBe(
        "prx://implement/ci",
      );
    } finally {
      setAuditRuntimeContext({ actor: before.actor, verb: before.verb });
    }
  });
});
