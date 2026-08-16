// prx-ux2 (slice 4a): the verify step as a signed `checks/v1` attestation.
//
// `checks_passed` should not be a self-reported boolean. The checks run
// (`bun run typecheck` / `bun test`) is a `ProcExecutor.exec`; wrapping it in
// `attestingChecks` makes a clean run emit a DSSE-signed `checks/v1` SLSA
// Derivation whose subject is the commit under test. These tests ARE the
// contract: a passing run signs a derivation for the commit (verifiable under
// the configured key); a failing run emits nothing (absence ≡ not verified).
import { describe, expect, test } from "bun:test";

import {
  ed25519Signer,
  ed25519Verifier,
  generateEd25519Keypair,
  type Derivation,
  type DerivationStore,
} from "@bounded-systems/anchored-chain";
import type { ProcExecutor } from "@bounded-systems/proc";

import type { ProcRequest } from "@bounded-systems/proc";

import {
  attestingChecks,
  CHECKS_BUILD_TYPE,
  runAttestedChecks,
  type AttestDeps,
} from "../../src/provenance/attest.ts";
import { verifySlsaDerivation } from "../../src/provenance/verify.ts";

const COMMIT = "1234567890abcdef1234567890abcdef12345678";

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

function mkAttest(store: FakeStore): {
  deps: AttestDeps;
  verifier: ReturnType<typeof ed25519Verifier>;
} {
  const kp = generateEd25519Keypair();
  return {
    deps: { signer: ed25519Signer(kp.privateKey, kp.keyid), store, now: () => 1000 },
    verifier: ed25519Verifier(kp.publicKey),
  };
}

/** A ProcExecutor that always exits with `status` (no real subprocess). */
function fakeExec(status: number): ProcExecutor {
  return {
    async exec() {
      return { status, stdout: "", stderr: "", signal: null };
    },
  };
}

describe("attestingChecks — verify step as a signed checks/v1 attestation (prx-ux2)", () => {
  test("a clean checks run signs a checks/v1 derivation whose subject is the commit", async () => {
    const store = fakeStore();
    const { deps, verifier } = mkAttest(store);
    const exec = attestingChecks(fakeExec(0), deps, COMMIT);

    const result = await exec.exec({ command: "bun", args: ["test"] });
    expect(result.status).toBe(0);

    expect(store.appended).toHaveLength(1);
    const derivation = store.appended[0]!;
    // The signed envelope verifies under the configured key.
    expect(await verifySlsaDerivation(derivation, verifier)).toBe(true);
    // The subject is the commit under test (not a boolean).
    expect(String(derivation.manifest.outputs.checks)).toBe(`gitCommit:${COMMIT}`);
  });

  test("a failing checks run emits nothing — absence ≡ not verified (fail-closed)", async () => {
    const store = fakeStore();
    const { deps } = mkAttest(store);
    const exec = attestingChecks(fakeExec(1), deps, COMMIT);

    const result = await exec.exec({ command: "bun", args: ["test"] });
    expect(result.status).toBe(1);
    expect(store.appended).toHaveLength(0);
  });

  test("re-attesting the same commit + command is idempotent (content-addressed)", async () => {
    const store = fakeStore();
    const { deps } = mkAttest(store);
    const exec = attestingChecks(fakeExec(0), deps, COMMIT);

    await exec.exec({ command: "bun", args: ["test"] });
    await exec.exec({ command: "bun", args: ["test"] });
    // Same manifest digest → the second append is a no-op (store.get hit).
    expect(store.appended).toHaveLength(1);
  });

  test("CHECKS_BUILD_TYPE is the checks/v1 predicate type", () => {
    expect(CHECKS_BUILD_TYPE).toBe("https://prx.dev/checks/v1");
  });
});

describe("runAttestedChecks — in-flow verify, signed per step (prx-ub4 slice 4c)", () => {
  /** Records each request and returns the queued statuses in order. */
  function recordingExec(statuses: number[]): {
    exec: {
      exec(
        req: ProcRequest,
      ): Promise<{ status: number; stdout: string; stderr: string; signal: null }>;
    };
    seen: ProcRequest[];
  } {
    const seen: ProcRequest[] = [];
    let i = 0;
    return {
      seen,
      exec: {
        async exec(req: ProcRequest) {
          seen.push(req);
          const status = statuses[i++] ?? 0;
          return { status, stdout: "", stderr: "", signal: null };
        },
      },
    };
  }

  const STEPS = [
    { command: "bun", args: ["run", "typecheck"] },
    { command: "bun", args: ["test"] },
  ];

  test("all steps pass → true, and each clean step signs a checks/v1", async () => {
    const store = fakeStore();
    const { deps } = mkAttest(store);
    const { exec, seen } = recordingExec([0, 0]);

    const ok = await runAttestedChecks(exec, deps, COMMIT, "/repo", STEPS);
    expect(ok).toBe(true);
    expect(seen.map((r) => r.args)).toEqual([["run", "typecheck"], ["test"]]);
    expect(store.appended).toHaveLength(2); // one checks/v1 per passing step
  });

  test("stops at the first failure → false, and does NOT attest the failed step", async () => {
    const store = fakeStore();
    const { deps } = mkAttest(store);
    const { exec, seen } = recordingExec([1, 0]); // typecheck fails

    const ok = await runAttestedChecks(exec, deps, COMMIT, "/repo", STEPS);
    expect(ok).toBe(false);
    expect(seen).toHaveLength(1); // never ran `bun test`
    expect(store.appended).toHaveLength(0); // a failing step is not attested
  });
});
