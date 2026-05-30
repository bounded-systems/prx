import type { KeyObject } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  digestManifest,
  ed25519Verifier,
  generateEd25519Keypair,
  ed25519Signer,
  type Derivation,
  type DerivationStore,
  type Digest,
} from "@bounded-systems/anchored-chain";
// Type-only: keeps this unit test free of the @bounded-systems/git → @bounded-systems/proc → zod
// runtime chain. The real `execGit` integration lives in attest-git.test.ts.
import type { execGit, GitExecOptions, GitExecResult } from "@bounded-systems/git";
import type { ProcExecutor, ProcRequest, ProcResult } from "@bounded-systems/proc";

import {
  GIT_COMMIT_BUILD_TYPE,
  attestingGit,
  attestingProc,
  type AttestDeps,
} from "../attest.ts";
import { slsaProvenanceStatement, verifySlsaEnvelope } from "../slsa.ts";

const BUILDER_ID = "prx://claude-code/submit";
const NOW = 1000;
const OID = "0123456789abcdef0123456789abcdef01234567";

type FakeStore = Pick<DerivationStore, "append" | "get"> & {
  readonly appended: Derivation[];
};

/** Map-backed store that records appends, idempotent on derivationId. */
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

/** Deps wired to a fresh ed25519 keypair; returns the public key for asserts. */
function mkDeps(store: FakeStore): { deps: AttestDeps; publicKey: KeyObject } {
  const kp = generateEd25519Keypair();
  return {
    deps: {
      signer: ed25519Signer(kp.privateKey, kp.keyid),
      store,
      builderId: BUILDER_ID,
      now: () => NOW,
    },
    publicKey: kp.publicKey,
  };
}

/**
 * A stub matching `typeof execGit`: a clean commit/push, HEAD resolving to a
 * fixed oid, and pass-through for everything else. Records the subcommands it
 * saw so the test can assert the post-success `rev-parse HEAD` happened.
 */
function fakeGit(
  overrides: Partial<Record<string, GitExecResult>> = {},
): typeof execGit & { calls: string[] } {
  const calls: string[] = [];
  const fn = ((opts: GitExecOptions): GitExecResult => {
    calls.push(opts.subcommand);
    if (overrides[opts.subcommand]) return overrides[opts.subcommand]!;
    if (opts.subcommand === "rev-parse") {
      return { exitCode: 0, stdout: `${OID}\n`, stderr: "", policy: null };
    }
    return { exitCode: 0, stdout: "", stderr: "", policy: null };
  }) as typeof execGit & { calls: string[] };
  fn.calls = calls;
  return fn;
}

describe("attestingGit — emit on a successful commit", () => {
  test("persists a signed derivation whose subject is the resolved HEAD", async () => {
    const store = fakeStore();
    const { deps, publicKey } = mkDeps(store);
    const git = fakeGit();
    const result = await attestingGit(git, deps)({
      subcommand: "commit",
      args: ["-m", "first"],
      cwd: "/repo",
    });

    expect(result.exitCode).toBe(0);
    expect(git.calls).toEqual(["commit", "rev-parse"]); // HEAD resolved post-success
    expect(store.appended).toHaveLength(1);

    const d = store.appended[0]!;
    expect(d.manifest.producer).toBe(BUILDER_ID);
    expect(d.manifest.outputs.commit).toBe(`gitCommit:${OID}` as Digest);
    expect(d.manifest.contracts).toEqual([]);
    expect(d.derivationId).toBe(digestManifest(d.manifest));
    expect(d.envelope?.signatures.length).toBe(1);

    const stmt = slsaProvenanceStatement({
      buildType: GIT_COMMIT_BUILD_TYPE,
      builderId: BUILDER_ID,
      subject: [{ name: "commit", digest: { gitCommit: OID } }],
      externalParameters: { subcommand: "commit", args: ["-m", "first"] },
      invocationId: d.derivationId as string,
      startedOn: new Date(NOW).toISOString(),
    });
    expect(
      await verifySlsaEnvelope(stmt, d.envelope!, ed25519Verifier(publicKey)),
    ).toBe(true);
  });

  test("a failed commit emits no derivation and does not resolve HEAD", async () => {
    const store = fakeStore();
    const git = fakeGit({
      commit: { exitCode: 1, stdout: "", stderr: "nothing to commit", policy: null },
    });
    const result = await attestingGit(git, mkDeps(store).deps)({
      subcommand: "commit",
      args: ["-m", "empty"],
      cwd: "/repo",
    });
    expect(result.exitCode).toBe(1);
    expect(git.calls).toEqual(["commit"]); // no post-success rev-parse
    expect(store.appended).toHaveLength(0);
  });

  test("a non-attestable subcommand (status) emits no derivation", async () => {
    const store = fakeStore();
    const git = fakeGit();
    await attestingGit(git, mkDeps(store).deps)({
      subcommand: "status",
      args: ["--porcelain"],
      cwd: "/repo",
    });
    expect(git.calls).toEqual(["status"]);
    expect(store.appended).toHaveLength(0);
  });

  test("an unresolvable HEAD passes through without a malformed link", async () => {
    const store = fakeStore();
    const git = fakeGit({
      "rev-parse": { exitCode: 128, stdout: "", stderr: "no HEAD", policy: null },
    });
    const result = await attestingGit(git, mkDeps(store).deps)({
      subcommand: "commit",
      args: ["-m", "first"],
      cwd: "/repo",
    });
    expect(result.exitCode).toBe(0);
    expect(store.appended).toHaveLength(0);
  });
});

describe("attestingProc — opt-in, caller-declared subject", () => {
  function inner(result: ProcResult): ProcExecutor {
    return { async exec() { return result; } };
  }
  const ok: ProcResult = { status: 0, stdout: "", stderr: "", signal: null };

  function declareArtifact() {
    return {
      buildType: "https://prx.dev/proc/build/v1",
      subject: [{ name: "artifact", digest: { sha256: "a".repeat(64) } }],
    };
  }

  test("emits when the caller declares a subject", async () => {
    const store = fakeStore();
    const exec = attestingProc(inner(ok), mkDeps(store).deps, () => declareArtifact());
    await exec.exec({ command: "make", args: ["dist"] } as ProcRequest);
    expect(store.appended).toHaveLength(1);
    expect(store.appended[0]!.manifest.outputs.artifact).toBe(
      `sha256:${"a".repeat(64)}` as Digest,
    );
  });

  test("is idempotent: an identical declared run appends once", async () => {
    const store = fakeStore();
    const exec = attestingProc(inner(ok), mkDeps(store).deps, () => declareArtifact());
    await exec.exec({ command: "make", args: ["dist"] } as ProcRequest);
    await exec.exec({ command: "make", args: ["dist"] } as ProcRequest);
    expect(store.appended).toHaveLength(1);
  });

  test("does not emit when no subject is declared (the common read case)", async () => {
    const store = fakeStore();
    const exec = attestingProc(inner(ok), mkDeps(store).deps, () => null);
    await exec.exec({ command: "ls", args: [] } as ProcRequest);
    expect(store.appended).toHaveLength(0);
  });

  test("does not emit on a failed run even if a subject is declared", async () => {
    const store = fakeStore();
    const failing = inner({ status: 1, stdout: "", stderr: "boom", signal: null });
    const exec = attestingProc(failing, mkDeps(store).deps, () => declareArtifact());
    const r = await exec.exec({ command: "make", args: ["dist"] } as ProcRequest);
    expect(r.status).toBe(1);
    expect(store.appended).toHaveLength(0);
  });
});
