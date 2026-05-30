// GH-2249 / GH-2348.2: `prx submit publish` requireSigned verify-before-PR gate.
//
// Since GH-2348.2 the push is delegated to keeper (`runKeeperPush`), which owns
// the SLSA emission (covered by test/pr-state/keeper.test.ts). submit-publish's
// remaining provenance responsibility is the *relocated* enforcement gate: when
// `requireSigned`, the captured push derivation must (a) attest the artifact
// head and (b) verify under the configured verifier — else fail closed BEFORE
// the PR opens. We exercise it through the real `runKeeperPush` with a stubbed
// `git` (so a real signed derivation is emitted into the capturing store) and a
// `prOpen` stub that records whether the PR was reached.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  ed25519Signer,
  ed25519Verifier,
  generateEd25519Keypair,
  type Derivation,
  type DerivationStore,
} from "@bounded-systems/anchored-chain";
// Type-only: keep this unit test off the @bounded-systems/git runtime chain;
// the push is exercised through runKeeperPush with a stubbed `git`.
import type { execGit, GitExecOptions, GitExecResult } from "@bounded-systems/git";

import { runKeeperPush } from "../../src/pr-state/keeper.ts";
import { type AttestDeps } from "../../src/provenance/attest.ts";
import { verifySlsaDerivation } from "../../src/provenance/verify.ts";
import { getRef } from "../../src/plan-store/cas.ts";
import {
  SUBMIT_DOMAIN,
  writeSubmitArtifact,
  type SubmitArtifact,
} from "../../src/submit/artifact.schema.ts";
import {
  PublishError,
  runSubmitPublish,
  type PublishDeps,
} from "../../src/submit/publish.ts";

const ENV_KEYS = ["PRX_PLAN_STORE", "PRX_CAS_ROOT", "PRX_AI_HOME_ROOT", "XDG_STATE_HOME", "HOME"] as const;
type EnvSnapshot = Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

const HEAD_SHA = "1234567890abcdef1234567890abcdef12345678";
const OTHER_SHA = "fedcba0987654321fedcba0987654321fedcba09";

function validArtifact(): SubmitArtifact {
  return {
    workUnitId: "GH-2269",
    baseRef: "main",
    baseSha: HEAD_SHA,
    tree: { sha: HEAD_SHA },
    patch: { sha: `sha256:${"0".repeat(64)}`, bytes: 0 },
    summary: "wire provenance",
    createdAt: "2026-05-26T00:00:00.000Z",
  };
}

const okRunner = () => ({ status: 0, stdout: "", stderr: "" });

type FakeStore = Pick<DerivationStore, "append" | "get"> & {
  readonly appended: Derivation[];
};
function fakeStore(): FakeStore {
  const map = new Map<string, Derivation>();
  const appended: Derivation[] = [];
  return {
    appended,
    async append(d) {
      map.set(d.derivationId as string, d);
      appended.push(d);
    },
    async get(id) {
      return map.get(id as string) ?? null;
    },
  };
}

function mkAttest(store: FakeStore): { deps: AttestDeps; verifier: ReturnType<typeof ed25519Verifier> } {
  const kp = generateEd25519Keypair();
  return {
    deps: { signer: ed25519Signer(kp.privateKey, kp.keyid), store, now: () => 1000 },
    verifier: ed25519Verifier(kp.publicKey),
  };
}

/** Stub matching `typeof execGit`: a clean push; HEAD resolves to `headOid`. */
function fakeGit(headOid: string): typeof execGit {
  return ((opts: GitExecOptions): GitExecResult =>
    opts.subcommand === "rev-parse"
      ? { exitCode: 0, stdout: `${headOid}\n`, stderr: "", policy: null }
      : { exitCode: 0, stdout: "", stderr: "", policy: null }) as typeof execGit;
}

/**
 * PublishDeps wiring the push through the real `runKeeperPush` (so a configured
 * signer emits a genuine derivation) but with a stubbed `git`, and a `prOpen`
 * spy. `headOid` is what the post-push `rev-parse HEAD` returns (defaults to the
 * artifact head; pass a different value to exercise the subject-equality check).
 */
function gate(opts: {
  attest?: AttestDeps;
  requireSigned?: boolean;
  verifier?: ReturnType<typeof ed25519Verifier>;
  headOid?: string;
}): { deps: PublishDeps; prOpened: () => number } {
  let prOpens = 0;
  const git = fakeGit(opts.headOid ?? HEAD_SHA);
  const deps: PublishDeps = {
    runner: okRunner,
    // GH-2381: keeper materializes the commit (= HEAD_SHA, the artifact head).
    // The push subject is controlled independently by `headOid`, so a mismatch
    // exercises the subject-equality defense.
    commitTree: async () => HEAD_SHA,
    keeperPush: (args, cwd, d) => runKeeperPush(args, cwd, { ...(d ?? {}), git }),
    prOpen: () => {
      prOpens += 1;
      return 0;
    },
    ...(opts.attest ? { attest: opts.attest } : {}),
    ...(opts.requireSigned ? { requireSigned: true } : {}),
    ...(opts.verifier ? { verifier: opts.verifier } : {}),
  };
  return { deps, prOpened: () => prOpens };
}

const PUBLISH_OPTS = {
  fromCas: "GH-2269:submit@ready",
  dryRun: false as const,
  ready: false as const,
  format: "plain" as const,
};

describe("runSubmitPublish — requireSigned verify-before-PR gate (GH-2249)", () => {
  let envSnap: EnvSnapshot;

  beforeEach(() => {
    envSnap = {};
    for (const k of ENV_KEYS) {
      envSnap[k] = process.env[k];
      delete process.env[k];
    }
    process.env.PRX_CAS_ROOT = mkdtempSync(join(tmpdir(), "prx-publish-require-cas-"));
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = envSnap[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("a signed push attesting the artifact head, verified by the matching verifier, opens the PR", async () => {
    await writeSubmitArtifact({ artifact: validArtifact(), slot: "ready" });
    const store = fakeStore();
    const { deps: attest, verifier } = mkAttest(store);
    const { deps, prOpened } = gate({ attest, requireSigned: true, verifier });

    const render = await runSubmitPublish(PUBLISH_OPTS, deps);

    expect(render.exitCode).toBe(0);
    // The push (via keeper) emitted a real, verifiable derivation; the gate
    // captured it, verified it, and proceeded to open the PR.
    expect(store.appended).toHaveLength(1);
    expect(await verifySlsaDerivation(store.appended[0]!, verifier)).toBe(true);
    expect(prOpened()).toBe(1);
    expect(await getRef("GH-2269:submit@published", { domain: SUBMIT_DOMAIN })).toBe(
      render.resolvedSha,
    );
  });

  test("requireSigned with no signer/ledger fails closed before the PR opens", async () => {
    await writeSubmitArtifact({ artifact: validArtifact(), slot: "ready" });
    const { verifier } = mkAttest(fakeStore());
    const { deps, prOpened } = gate({ requireSigned: true, verifier }); // no attest

    await expect(runSubmitPublish(PUBLISH_OPTS, deps)).rejects.toBeInstanceOf(PublishError);
    expect(prOpened()).toBe(0); // the push ran, but no PR was opened
    expect(await getRef("GH-2269:submit@published", { domain: SUBMIT_DOMAIN })).toBeNull();
  });

  test("requireSigned with a wrong-key verifier fails closed before the PR opens", async () => {
    await writeSubmitArtifact({ artifact: validArtifact(), slot: "ready" });
    const store = fakeStore();
    const { deps: attest } = mkAttest(store);
    const { verifier: wrongVerifier } = mkAttest(fakeStore()); // independent keypair
    const { deps, prOpened } = gate({ attest, requireSigned: true, verifier: wrongVerifier });

    await expect(runSubmitPublish(PUBLISH_OPTS, deps)).rejects.toBeInstanceOf(PublishError);
    expect(store.appended).toHaveLength(1); // emission still happened
    expect(prOpened()).toBe(0); // but the PR was blocked
  });

  test("requireSigned set without a verifier fails closed", async () => {
    await writeSubmitArtifact({ artifact: validArtifact(), slot: "ready" });
    const store = fakeStore();
    const { deps: attest } = mkAttest(store);
    const { deps, prOpened } = gate({ attest, requireSigned: true }); // no verifier

    await expect(runSubmitPublish(PUBLISH_OPTS, deps)).rejects.toBeInstanceOf(PublishError);
    expect(prOpened()).toBe(0);
  });

  test("GH-2348.2: a signed push attesting a different commit fails the subject-equality defense", async () => {
    await writeSubmitArtifact({ artifact: validArtifact(), slot: "ready" });
    const store = fakeStore();
    const { deps: attest, verifier } = mkAttest(store);
    // The push verifies, but its subject is OTHER_SHA, not the artifact head.
    const { deps, prOpened } = gate({ attest, requireSigned: true, verifier, headOid: OTHER_SHA });

    await expect(runSubmitPublish(PUBLISH_OPTS, deps)).rejects.toBeInstanceOf(PublishError);
    expect(store.appended).toHaveLength(1); // a valid derivation was emitted…
    expect(prOpened()).toBe(0); // …but it attests the wrong commit, so the PR is blocked
    expect(await getRef("GH-2269:submit@published", { domain: SUBMIT_DOMAIN })).toBeNull();
  });

  test("flag unset: no verification even with a non-matching verifier (unchanged)", async () => {
    await writeSubmitArtifact({ artifact: validArtifact(), slot: "ready" });
    const store = fakeStore();
    const { deps: attest } = mkAttest(store);
    const { verifier: wrongVerifier } = mkAttest(fakeStore());
    // requireSigned absent ⇒ the verifier is never consulted; publish proceeds.
    const { deps, prOpened } = gate({ attest, verifier: wrongVerifier });

    const render = await runSubmitPublish(PUBLISH_OPTS, deps);
    expect(render.exitCode).toBe(0);
    expect(prOpened()).toBe(1);
  });
});
