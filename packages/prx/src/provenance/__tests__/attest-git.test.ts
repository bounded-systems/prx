/**
 * End-to-end emission proof (spike Phase A exit): a real `prx` git commit
 * through the real `execGit` capability emits a signed SLSA-v1 `Derivation`,
 * verifiable via the existing `Verifier`. Kept separate from attest.test.ts
 * because importing the runtime `execGit` pulls the @bounded-systems/proc → zod chain, so
 * this file only runs where workspace deps are installed (CI); the decorator
 * logic itself is covered offline in attest.test.ts with a stubbed git.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  digestManifest,
  ed25519Verifier,
  generateEd25519Keypair,
  ed25519Signer,
  type Derivation,
  type DerivationStore,
  type Digest,
} from "@bounded-systems/anchored-chain";
import { execGit } from "@bounded-systems/git";

import {
  GIT_COMMIT_BUILD_TYPE,
  attestingGit,
  type AttestDeps,
} from "../attest.ts";
import { slsaProvenanceStatement, verifySlsaEnvelope } from "../slsa.ts";

const BUILDER_ID = "prx://claude-code/submit";
const NOW = 1000;

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

describe("attestingGit — real git commit (end-to-end)", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "prx-attest-git-"));
    execFileSync("git", ["-C", repo, "init", "-q"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "t@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Tester"]);
    execFileSync("git", ["-C", repo, "config", "commit.gpgsign", "false"]);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test("a clean commit emits a signed SLSA derivation of the new commit", async () => {
    writeFileSync(join(repo, "a.txt"), "hello\n");
    execFileSync("git", ["-C", repo, "add", "a.txt"]);

    const store = fakeStore();
    const kp = generateEd25519Keypair();
    const deps: AttestDeps = {
      signer: ed25519Signer(kp.privateKey, kp.keyid),
      store,
      builderId: BUILDER_ID,
      now: () => NOW,
    };

    const result = await attestingGit(execGit, deps)({
      subcommand: "commit",
      args: ["-m", "first"],
      cwd: repo,
    });
    expect(result.exitCode).toBe(0);
    expect(store.appended).toHaveLength(1);

    const d = store.appended[0]!;
    const oid = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();

    expect(d.manifest.outputs.commit).toBe(`gitCommit:${oid}` as Digest);
    expect(d.derivationId).toBe(digestManifest(d.manifest));

    const stmt = slsaProvenanceStatement({
      buildType: GIT_COMMIT_BUILD_TYPE,
      builderId: BUILDER_ID,
      subject: [{ name: "commit", digest: { gitCommit: oid } }],
      externalParameters: { subcommand: "commit", args: ["-m", "first"] },
      invocationId: d.derivationId as string,
      startedOn: new Date(NOW).toISOString(),
    });
    expect(
      await verifySlsaEnvelope(stmt, d.envelope!, ed25519Verifier(kp.publicKey)),
    ).toBe(true);
  });
});
