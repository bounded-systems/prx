// GH-1900 / GH-2348.2: `prx submit publish` orchestrates a CAS artifact →
// keeper push + publisher PR-open + ref-advance. The push/PR side effects are
// delegated (keeper, publisher) and injected here as seams; the orchestrator
// only runs the parity preflight (via `runner`) and advances the slot.

import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnSyncReturns } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  ed25519Signer,
  ed25519Verifier,
  generateEd25519Keypair,
} from "@bounded-systems/anchored-chain";
import type { execGit, GitExecOptions, GitExecResult } from "@bounded-systems/git";

import { getRef } from "../../src/plan-store/cas.ts";
import { statement } from "@bounded-systems/ocap-provenance";
import { toSLSA } from "@bounded-systems/ocap-provenance/slsa";

import { canonicalJson } from "../../src/provenance/verify-l3.ts";
import { runKeeperServe, type KeeperDaemonDeps } from "../../src/keeperd/daemon.ts";
import { runKeeperDoorPush } from "../../src/keeperd/host.ts";
import {
  SUBMIT_DOMAIN,
  writeSubmitArtifact,
  type SubmitArtifact,
} from "../../src/submit/artifact.schema.ts";
import { PublishError, runSubmitPublish, type PublishDeps } from "../../src/submit/publish.ts";

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

const MATERIALIZED_COMMIT = "abcabcabcabcabcabcabcabcabcabcabcabcabca";

function validArtifact(overrides: Partial<SubmitArtifact> = {}): SubmitArtifact {
  return {
    workUnitId: "GH-1900",
    baseRef: "main",
    baseSha: HEX40,
    tree: { sha: HEX40 },
    patch: { sha: `sha256:${HEX64}`, bytes: 0 },
    summary: "publish handoff",
    createdAt: "2026-05-17T00:00:00.000Z",
    ...overrides,
  };
}

/** Preflight runner result (the `prx chain check-issue` call). */
function ok(): SpawnSyncReturns<string> {
  return { pid: 1, status: 0, signal: null, stdout: "", stderr: "", output: ["", "", ""] };
}
function fail(stderr: string, status = 1): SpawnSyncReturns<string> {
  return { pid: 1, status, signal: null, stdout: "", stderr, output: ["", "", stderr] };
}

/**
 * Records the delegated calls so tests can assert orchestration order/args
 * without real git/gh. `keeperPush` returns a `GitExecResult`; `prOpen` an exit
 * code. Both default to success.
 */
function spy(
  over: {
    pushExit?: number;
    pushStderr?: string;
    prExit?: number;
    runner?: PublishDeps["runner"];
  } = {},
): {
  deps: PublishDeps;
  preflight: Array<{ cmd: string; args: string[] }>;
  commits: Array<{ treeSha: string; parentSha: string; branch: string }>;
  pushes: string[][];
  prOpens: Array<{
    workUnitId: string;
    summary: string;
    head: string | undefined;
    base: string | undefined;
    ready: boolean | undefined;
  }>;
} {
  const preflight: Array<{ cmd: string; args: string[] }> = [];
  const commits: Array<{ treeSha: string; parentSha: string; branch: string }> = [];
  const pushes: string[][] = [];
  const prOpens: Array<{
    workUnitId: string;
    summary: string;
    head: string | undefined;
    base: string | undefined;
    ready: boolean | undefined;
  }> = [];
  const deps: PublishDeps = {
    runner:
      over.runner ??
      ((cmd, args) => {
        preflight.push({ cmd, args });
        return ok();
      }),
    // GH-2381: keeper materializes the publishable commit from the tree artifact.
    async commitTree(input) {
      commits.push({ treeSha: input.treeSha, parentSha: input.parentSha, branch: input.branch });
      return MATERIALIZED_COMMIT;
    },
    async keeperPush(args) {
      pushes.push(args);
      return {
        exitCode: over.pushExit ?? 0,
        stdout: "",
        stderr: over.pushStderr ?? "",
        policy: null,
      };
    },
    prOpen(target, options) {
      prOpens.push({
        workUnitId: target.workUnitId,
        summary: options.summary,
        head: options.head,
        base: options.base,
        ready: options.ready,
      });
      return over.prExit ?? 0;
    },
  };
  return { deps, preflight, commits, pushes, prOpens };
}

describe("runSubmitPublish (GH-1900 / GH-2348.2)", () => {
  let envSnap: EnvSnapshot;
  let casRoot: string;

  beforeEach(() => {
    envSnap = snapshotEnv();
    casRoot = mkdtempSync(join(tmpdir(), "prx-submit-publish-cas-"));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.PRX_CAS_ROOT = casRoot;
  });

  afterEach(() => {
    restoreEnv(envSnap);
  });

  test("dry-run resolves the ref → sha and prints the keeper+publisher plan without delegating", async () => {
    await writeSubmitArtifact({ artifact: validArtifact(), slot: "ready" });
    const { deps, preflight, commits, pushes, prOpens } = spy();
    const render = await runSubmitPublish(
      { fromCas: "GH-1900:submit@ready", dryRun: true, ready: false, format: "plain" },
      deps,
    );
    expect(preflight).toHaveLength(0);
    expect(commits).toHaveLength(0);
    expect(pushes).toHaveLength(0);
    expect(prOpens).toHaveLength(0);
    expect(render.dryRun).toBe(true);
    expect(render.exitCode).toBe(0);
    expect(render.artifact.workUnitId).toBe("GH-1900");
    expect(render.steps.map((s) => s.kind)).toEqual([
      "preflight",
      "keeper-commit",
      "keeper-push",
      "publisher-pr-open",
      "set-ref",
    ]);
    const push = render.steps.find((s) => s.kind === "keeper-push");
    expect(push?.argv).toEqual(["prx", "keeper", "push", "origin", "GH-1900"]);
    // Draft is the default → the plan detail flags it.
    const pr = render.steps.find((s) => s.kind === "publisher-pr-open");
    expect(pr?.detail).toContain("(draft)");
  });

  test("GH-2267: draft by default — prOpen is called with ready:false", async () => {
    const { sha } = await writeSubmitArtifact({ artifact: validArtifact(), slot: "ready" });
    const { deps, prOpens } = spy();
    await runSubmitPublish(
      { fromCas: "GH-1900:submit@ready", dryRun: false, ready: false, format: "plain" },
      deps,
    );
    expect(prOpens).toHaveLength(1);
    expect(prOpens[0]!.ready).toBe(false);
    expect(await getRef("GH-1900:submit@published", { domain: SUBMIT_DOMAIN })).toBe(sha);
  });

  test("GH-2267: --ready opts out of draft — prOpen is called with ready:true", async () => {
    await writeSubmitArtifact({ artifact: validArtifact(), slot: "ready" });
    const { deps, prOpens } = spy();
    await runSubmitPublish(
      { fromCas: "GH-1900:submit@ready", dryRun: false, ready: true, format: "plain" },
      deps,
    );
    expect(prOpens[0]!.ready).toBe(true);
  });

  test("non-dry-run runs preflight → keeper commit → keeper push → publisher pr-open → setRef(:published)", async () => {
    const { sha } = await writeSubmitArtifact({ artifact: validArtifact(), slot: "ready" });
    const { deps, preflight, commits, pushes, prOpens } = spy();

    const render = await runSubmitPublish(
      { fromCas: "GH-1900:submit@ready", dryRun: false, ready: false, format: "plain" },
      deps,
    );

    expect(render.exitCode).toBe(0);
    // Preflight is the only `runner` call; commit/push + PR are delegated.
    expect(preflight).toHaveLength(1);
    expect(preflight[0]!.cmd).toBe("prx");
    expect(preflight[0]!.args).toEqual(["chain", "check-issue", "GH-1900"]);
    // GH-2381: keeper materializes the commit from the tree + base, branch GH-<n>.
    expect(commits).toEqual([{ treeSha: HEX40, parentSha: HEX40, branch: "GH-1900" }]);
    expect(pushes).toEqual([["origin", "GH-1900"]]);
    expect(prOpens).toEqual([
      {
        workUnitId: "GH-1900",
        summary: "publish handoff",
        head: "GH-1900",
        base: "main",
        ready: false,
      },
    ]);

    // The published-slot ref now points at the artifact metadata sha.
    const published = await getRef("GH-1900:submit@published", { domain: SUBMIT_DOMAIN });
    expect(published).toBe(sha);
  });

  test("accepts a raw sha256:… handle, skips the ref resolve", async () => {
    const { sha } = await writeSubmitArtifact({ artifact: validArtifact(), slot: "ready" });
    const { deps } = spy();
    const render = await runSubmitPublish(
      { fromCas: sha, dryRun: true, ready: false, format: "plain" },
      deps,
    );
    expect(render.resolvedSha).toBe(sha);
  });

  test("missing ref → PublishError with a clear hint", async () => {
    const { deps } = spy();
    await expect(
      runSubmitPublish(
        { fromCas: "GH-9999:submit@ready", dryRun: true, ready: false, format: "plain" },
        deps,
      ),
    ).rejects.toBeInstanceOf(PublishError);
  });

  test("malformed ref shape → PublishError before any delegation", async () => {
    const { deps, preflight, pushes, prOpens } = spy();
    await expect(
      runSubmitPublish(
        { fromCas: "GH-1:notsubmit@draft", dryRun: true, ready: false, format: "plain" },
        deps,
      ),
    ).rejects.toThrow();
    expect(preflight).toHaveLength(0);
    expect(pushes).toHaveLength(0);
    expect(prOpens).toHaveLength(0);
  });

  test("preflight failure stops the pipeline; no push, no PR, ref unchanged", async () => {
    await writeSubmitArtifact({ artifact: validArtifact(), slot: "ready" });
    const { deps, pushes, prOpens } = spy({
      runner: (cmd) => (cmd === "prx" ? fail("chain check-issue: parity drift") : ok()),
    });

    await expect(
      runSubmitPublish(
        { fromCas: "GH-1900:submit@ready", dryRun: false, ready: false, format: "plain" },
        deps,
      ),
    ).rejects.toBeInstanceOf(PublishError);

    expect(pushes).toHaveLength(0);
    expect(prOpens).toHaveLength(0);
    expect(await getRef("GH-1900:submit@published", { domain: SUBMIT_DOMAIN })).toBeNull();
  });

  test("keeper push failure does not open a PR or advance the published ref", async () => {
    await writeSubmitArtifact({ artifact: validArtifact(), slot: "ready" });
    const { deps, prOpens } = spy({ pushExit: 1, pushStderr: "rejected: tip is behind" });

    await expect(
      runSubmitPublish(
        { fromCas: "GH-1900:submit@ready", dryRun: false, ready: false, format: "plain" },
        deps,
      ),
    ).rejects.toBeInstanceOf(PublishError);

    expect(prOpens).toHaveLength(0);
    expect(await getRef("GH-1900:submit@published", { domain: SUBMIT_DOMAIN })).toBeNull();
  });

  test("publisher pr-open failure does not advance the published ref", async () => {
    await writeSubmitArtifact({ artifact: validArtifact(), slot: "ready" });
    const { deps, pushes } = spy({ prExit: 1 });

    await expect(
      runSubmitPublish(
        { fromCas: "GH-1900:submit@ready", dryRun: false, ready: false, format: "plain" },
        deps,
      ),
    ).rejects.toBeInstanceOf(PublishError);

    // The push ran (side effect happened) but the slot is not advanced.
    expect(pushes).toEqual([["origin", "GH-1900"]]);
    expect(await getRef("GH-1900:submit@published", { domain: SUBMIT_DOMAIN })).toBeNull();
  });
});

describe("runSubmitPublish — keeper door mode (box profile, prx-asr)", () => {
  let envSnap: EnvSnapshot;
  let casRoot: string;
  let doorCounter = 0;

  beforeEach(() => {
    envSnap = snapshotEnv();
    casRoot = mkdtempSync(join(tmpdir(), "prx-submit-publish-door-"));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.PRX_CAS_ROOT = casRoot;
  });
  afterEach(() => restoreEnv(envSnap));

  const PUBLISH = {
    fromCas: "GH-1900:submit@ready",
    dryRun: false,
    ready: false,
    format: "plain" as const,
  };

  test("routes the push through the keeperd door — no local push", async () => {
    await writeSubmitArtifact({ artifact: validArtifact(), slot: "ready" });
    const { deps, pushes, prOpens } = spy();
    const doorCalls: Array<{
      parentSha: string;
      commitSha: string;
      branch: string;
      remote: string;
    }> = [];
    deps.keeperDoorMode = () => true;
    deps.keeperDoor = async (input) => {
      doorCalls.push({
        parentSha: input.parentSha,
        commitSha: input.commitSha,
        branch: input.branch,
        remote: input.remote,
      });
      return { status: "ok", commitSha: MATERIALIZED_COMMIT, pushedRef: "refs/heads/GH-1900" };
    };
    const render = await runSubmitPublish(PUBLISH, deps);
    expect(render.exitCode).toBe(0);
    expect(pushes).toHaveLength(0); // the LOCAL push seam was not used
    expect(doorCalls).toEqual([
      { parentSha: HEX40, commitSha: MATERIALIZED_COMMIT, branch: "GH-1900", remote: "origin" },
    ]);
    expect(prOpens).toHaveLength(1); // PR still opens after a clean door push
  });

  test("a door push error fails closed — no PR opened", async () => {
    await writeSubmitArtifact({ artifact: validArtifact(), slot: "ready" });
    const { deps, prOpens } = spy();
    deps.keeperDoorMode = () => true;
    deps.keeperDoor = async () => ({
      status: "error",
      code: "git-write",
      message: "remote rejected",
    });
    await expect(runSubmitPublish(PUBLISH, deps)).rejects.toThrow(
      /keeper door push failed.*remote rejected/,
    );
    expect(prOpens).toHaveLength(0);
  });

  test("the daemon reporting a different commit fails closed", async () => {
    await writeSubmitArtifact({ artifact: validArtifact(), slot: "ready" });
    const { deps, prOpens } = spy();
    deps.keeperDoorMode = () => true;
    deps.keeperDoor = async () => ({
      status: "ok",
      commitSha: "f".repeat(40),
      pushedRef: "refs/heads/GH-1900",
    });
    await expect(runSubmitPublish(PUBLISH, deps)).rejects.toThrow(/not the materialized commit/);
    expect(prOpens).toHaveLength(0);
  });

  test("requireSigned + door + no signed derivation fails closed", async () => {
    await writeSubmitArtifact({ artifact: validArtifact(), slot: "ready" });
    const { deps } = spy();
    deps.keeperDoorMode = () => true;
    deps.requireSigned = true;
    deps.verifier = {} as unknown as NonNullable<PublishDeps["verifier"]>;
    deps.keeperDoor = async () => ({
      status: "ok",
      commitSha: MATERIALIZED_COMMIT,
      pushedRef: "refs/heads/GH-1900",
    });
    await expect(runSubmitPublish(PUBLISH, deps)).rejects.toThrow(/emitted no signed attestation/);
  });

  test("requireSigned + door + a valid door-keeper L3 verifies → PR opens", async () => {
    await writeSubmitArtifact({ artifact: validArtifact(), slot: "ready" });
    const { deps, prOpens } = spy();
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;
    const statement = {
      _type: "https://in-toto.io/Statement/v1",
      subject: [{ name: MATERIALIZED_COMMIT, digest: { gitCommit: MATERIALIZED_COMMIT } }],
      predicateType: "https://slsa.dev/provenance/v1",
    };
    const l3 = {
      statement,
      signature: sign(null, Buffer.from(canonicalJson(statement)), privateKey).toString("base64"),
      keyId: "test",
    };
    deps.keeperDoorMode = () => true;
    deps.requireSigned = true;
    deps.resolveKeeperKey = () => pubPem;
    deps.keeperDoor = async () => ({
      status: "ok",
      commitSha: MATERIALIZED_COMMIT,
      pushedRef: "refs/heads/GH-1900",
      signedDerivation: l3,
    });
    await runSubmitPublish(PUBLISH, deps);
    expect(prOpens).toHaveLength(1);
  });

  // ── capability-chain enforcement (L3 write → L2 launch) ──────────────────────
  const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
  function buildL2(launcherPriv: ReturnType<typeof generateKeyPairSync>["privateKey"]) {
    const slsa = toSLSA(
      statement([{ name: "box-1", digest: { sha256: "e".repeat(64) } }], {
        level: "launch",
        producer: { kind: "nix-flake", id: "launcher" },
        capabilities: { workcell: "claude-box", manifestDigest: { sha256: "e".repeat(64) } },
      }),
    );
    return { statement: slsa, signature: sign(null, Buffer.from(canonicalJson(slsa)), launcherPriv).toString("base64") };
  }
  function buildLinkedL3(keeperPriv: ReturnType<typeof generateKeyPairSync>["privateKey"], l2Digest: string) {
    const slsa = toSLSA(
      statement([{ name: MATERIALIZED_COMMIT, digest: { gitCommit: MATERIALIZED_COMMIT } }], {
        level: "write",
        producer: { kind: "keeperd", id: "keeper" },
        capabilities: { workcell: "claude-box", manifestDigest: { sha256: "e".repeat(64) } },
        links: [{ level: "launch", digest: { sha256: l2Digest } }],
      }),
    );
    return { statement: slsa, signature: sign(null, Buffer.from(canonicalJson(slsa)), keeperPriv).toString("base64"), keyId: "keeper" };
  }
  const chainSpy = () => {
    const keeper = generateKeyPairSync("ed25519");
    const launcher = generateKeyPairSync("ed25519");
    const l2 = buildL2(launcher.privateKey);
    const l3 = buildLinkedL3(keeper.privateKey, sha256(canonicalJson(l2.statement)));
    return {
      l2,
      l3,
      kPem: keeper.publicKey.export({ type: "spki", format: "pem" }) as string,
      lPem: launcher.publicKey.export({ type: "spki", format: "pem" }) as string,
    };
  };

  test("requireSigned + door + a valid L3→L2 launch chain → PR opens", async () => {
    await writeSubmitArtifact({ artifact: validArtifact(), slot: "ready" });
    const { deps, prOpens } = spy();
    const { l2, l3, kPem, lPem } = chainSpy();
    deps.keeperDoorMode = () => true;
    deps.requireSigned = true;
    deps.resolveKeeperKey = () => kPem;
    deps.resolveLauncherKey = () => lPem;
    deps.resolveLaunchAttestation = async () => l2;
    deps.keeperDoor = async () => ({ status: "ok", commitSha: MATERIALIZED_COMMIT, pushedRef: "refs/heads/GH-1900", signedDerivation: l3 });
    await runSubmitPublish(PUBLISH, deps);
    expect(prOpens).toHaveLength(1);
  });

  test("requireSigned + door + launcher key set but L2 not found → fail closed", async () => {
    await writeSubmitArtifact({ artifact: validArtifact(), slot: "ready" });
    const { deps } = spy();
    const { l3, kPem, lPem } = chainSpy();
    deps.keeperDoorMode = () => true;
    deps.requireSigned = true;
    deps.resolveKeeperKey = () => kPem;
    deps.resolveLauncherKey = () => lPem;
    deps.resolveLaunchAttestation = async () => null;
    deps.keeperDoor = async () => ({ status: "ok", commitSha: MATERIALIZED_COMMIT, pushedRef: "refs/heads/GH-1900", signedDerivation: l3 });
    await expect(runSubmitPublish(PUBLISH, deps)).rejects.toThrow(/no L2 launch attestation found/);
  });

  test("requireSigned + door + L3 links a non-verifying L2 → fail closed", async () => {
    await writeSubmitArtifact({ artifact: validArtifact(), slot: "ready" });
    const { deps } = spy();
    const { l2, l3, kPem } = chainSpy();
    // a launcher key that did NOT sign this L2
    const wrongLauncher = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }) as string;
    deps.keeperDoorMode = () => true;
    deps.requireSigned = true;
    deps.resolveKeeperKey = () => kPem;
    deps.resolveLauncherKey = () => wrongLauncher;
    deps.resolveLaunchAttestation = async () => l2;
    deps.keeperDoor = async () => ({ status: "ok", commitSha: MATERIALIZED_COMMIT, pushedRef: "refs/heads/GH-1900", signedDerivation: l3 });
    await expect(runSubmitPublish(PUBLISH, deps)).rejects.toThrow(/does not chain to a verifiable L2 launch/);
  });

  test("requireSigned + door + L3 verifies but NO launcher key → chain enforcement skipped (PR opens)", async () => {
    await writeSubmitArtifact({ artifact: validArtifact(), slot: "ready" });
    const { deps, prOpens } = spy();
    const { l2, l3, kPem } = chainSpy();
    deps.keeperDoorMode = () => true;
    deps.requireSigned = true;
    deps.resolveKeeperKey = () => kPem;
    deps.resolveLauncherKey = () => null; // opt-out → only L3 verified
    deps.resolveLaunchAttestation = async () => l2;
    deps.keeperDoor = async () => ({ status: "ok", commitSha: MATERIALIZED_COMMIT, pushedRef: "refs/heads/GH-1900", signedDerivation: l3 });
    await runSubmitPublish(PUBLISH, deps);
    expect(prOpens).toHaveLength(1);
  });

  test("requireSigned + door + L3 under the WRONG keeper key fails closed", async () => {
    await writeSubmitArtifact({ artifact: validArtifact(), slot: "ready" });
    const { deps } = spy();
    const signer = generateKeyPairSync("ed25519");
    const wrongPub = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }) as string;
    const statement = {
      subject: [{ name: MATERIALIZED_COMMIT, digest: { gitCommit: MATERIALIZED_COMMIT } }],
    };
    deps.keeperDoorMode = () => true;
    deps.requireSigned = true;
    deps.resolveKeeperKey = () => wrongPub;
    deps.keeperDoor = async () => ({
      status: "ok",
      commitSha: MATERIALIZED_COMMIT,
      pushedRef: "refs/heads/GH-1900",
      signedDerivation: {
        statement,
        signature: sign(null, Buffer.from(canonicalJson(statement)), signer.privateKey).toString("base64"),
      },
    });
    await expect(runSubmitPublish(PUBLISH, deps)).rejects.toThrow(/L3 does not verify/);
  });

  test("requireSigned + door + L3 but no keeper trust key configured fails closed", async () => {
    await writeSubmitArtifact({ artifact: validArtifact(), slot: "ready" });
    const { deps } = spy();
    deps.keeperDoorMode = () => true;
    deps.requireSigned = true;
    deps.resolveKeeperKey = () => null;
    deps.keeperDoor = async () => ({
      status: "ok",
      commitSha: MATERIALIZED_COMMIT,
      pushedRef: "refs/heads/GH-1900",
      signedDerivation: { statement: { subject: [] }, signature: "x" },
    });
    await expect(runSubmitPublish(PUBLISH, deps)).rejects.toThrow(/no keeper trust key is configured/);
  });

  test("requireSigned + door + signed derivation for the WRONG commit fails closed", async () => {
    await writeSubmitArtifact({ artifact: validArtifact(), slot: "ready" });
    const { deps } = spy();
    deps.keeperDoorMode = () => true;
    deps.requireSigned = true;
    deps.verifier = {} as unknown as NonNullable<PublishDeps["verifier"]>;
    deps.keeperDoor = async () => ({
      status: "ok",
      commitSha: MATERIALIZED_COMMIT,
      pushedRef: "refs/heads/GH-1900",
      signedDerivation: { manifest: { outputs: { commit: `gitCommit:${"f".repeat(40)}` } } },
    });
    await expect(runSubmitPublish(PUBLISH, deps)).rejects.toThrow(/not the materialized commit/);
  });

  // ── REAL keeperd over the door (prx-lt4q / #644) ─────────────────────────────
  // The fakes above prove the gate's branch logic; these prove the SEAM the fakes
  // can't: runSubmitPublish ↔ the real keeperd client (framed unix socket) ↔ a
  // real daemon + real ed25519 signer ↔ the requireSigned verifier. Git is faked
  // inside the daemon (no real push), but the signing + the returned
  // `signedDerivation` are genuine — the door wire-contract round-trip is real.

  const okGit = (stdout = ""): GitExecResult => ({ exitCode: 0, stdout, stderr: "", policy: null });
  // A daemon git that succeeds and reports the materialized commit as the imported
  // tip / post-push HEAD — so `attestingGit` attests `gitCommit:MATERIALIZED_COMMIT`.
  const daemonGit = ((opts: GitExecOptions): GitExecResult =>
    opts.subcommand === "rev-parse" ? okGit(MATERIALIZED_COMMIT) : okGit()) as typeof execGit;

  async function withKeeperd(
    deps: KeeperDaemonDeps,
    body: (socketPath: string) => Promise<void>,
  ): Promise<void> {
    const socketPath = join(tmpdir(), `keeperd-publish-${process.pid}-${doorCounter++}.sock`);
    const server = await runKeeperServe({ socketPath, deps });
    // door-kit's keeper client reads KEEPERD_SOCK (the pod projects it).
    const prev = process.env.KEEPERD_SOCK;
    process.env.KEEPERD_SOCK = socketPath;
    try {
      await body(socketPath);
    } finally {
      if (prev === undefined) delete process.env.KEEPERD_SOCK;
      else process.env.KEEPERD_SOCK = prev;
      await server.close();
    }
  }

  test("requireSigned + door: a REAL keeperd-signed derivation verifies → PR opens (prx-lt4q/#644)", async () => {
    await writeSubmitArtifact({ artifact: validArtifact(), slot: "ready" });
    const kp = generateEd25519Keypair();
    await withKeeperd(
      {
        git: daemonGit,
        signer: ed25519Signer(kp.privateKey, kp.keyid),
        // a capturing in-memory ledger; the daemon also RETURNS the derivation (#644)
        openLedger: () => ({
          store: { append: async () => {}, get: async () => null },
          close: () => {},
        }),
      },
      async () => {
        const { deps, pushes, prOpens } = spy();
        deps.keeperDoorMode = () => true;
        // the REAL door client; only the local bundle bytes are stubbed (not under test)
        deps.keeperDoor = (input) => runKeeperDoorPush(input, { bundle: () => "AA==" });
        deps.keeperLedgerRef = "refs/prx/ledger"; // opt the daemon into attesting
        deps.requireSigned = true;
        deps.verifier = ed25519Verifier(kp.publicKey);

        const render = await runSubmitPublish(PUBLISH, deps);
        expect(render.exitCode).toBe(0); // the gate VERIFIED a real daemon-signed derivation
        expect(pushes).toHaveLength(0); // routed through the door, not the local push
        expect(prOpens).toHaveLength(1); // requireSigned satisfied over the door → PR opens
      },
    );
  });

  test("requireSigned + door: a REAL bare-push daemon (no signer) returns nothing → fails closed", async () => {
    await writeSubmitArtifact({ artifact: validArtifact(), slot: "ready" });
    const kp = generateEd25519Keypair();
    await withKeeperd(
      { git: daemonGit }, // no signer/openLedger → bare push, no signedDerivation
      async () => {
        const { deps, prOpens } = spy();
        deps.keeperDoorMode = () => true;
        deps.keeperDoor = (input) => runKeeperDoorPush(input, { bundle: () => "AA==" });
        deps.keeperLedgerRef = "refs/prx/ledger";
        deps.requireSigned = true;
        deps.verifier = ed25519Verifier(kp.publicKey);

        await expect(runSubmitPublish(PUBLISH, deps)).rejects.toThrow(
          /emitted no signed attestation/,
        );
        expect(prOpens).toHaveLength(0); // fail closed before the PR opens
      },
    );
  });
});
