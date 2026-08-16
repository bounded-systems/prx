/**
 * GH-2338: `resolveMergeGuardProvenanceAxis` canonical per-UoW ledger wiring.
 *
 * GH-2249 made the merge-guard provenance gate opt-in per invocation — it only
 * ran when `--ledger <path>` was supplied. This locks the GH-2338 behaviour:
 *
 *   - AC-4: with `PRX_REQUIRE_SIGNED_DERIVATIONS` unset the resolver is a no-op
 *     (`undefined` for every input) — the flag-unset path is unchanged.
 *   - AC-3: with the flag set and no ledger resolvable (not a reserved UoW, no
 *     `--ledger`) the resolver fails closed (`"unsigned"`, the blocking verdict)
 *     rather than silently passing.
 *   - AC-2: an explicit `--ledger` still wins — it opens that ledger instead of
 *     falling back to the canonical one.
 *   - AC-1: in a reserved UoW with no `--ledger`, the resolver auto-resolves the
 *     canonical ledger; an unverifiable `push/v1` derivation for HEAD ⇒ blocks.
 *
 * The projection's own verdict semantics are covered by
 * `src/provenance/__tests__/merge-guard.test.ts`; here we exercise the wiring.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  ed25519Signer,
  generateEd25519Keypair,
  type DerivationStore,
} from "@bounded-systems/anchored-chain";
import { openAnchoredChain } from "@bounded-systems/anchored-chain-sqlite";
import type { ProcExecutor, ProcRequest, ProcResult } from "@bounded-systems/proc";

import {
  attestingProc,
  GIT_PUSH_BUILD_TYPE,
  type AttestDeps,
} from "../../src/provenance/attest.ts";
import { resolveMergeGuardProvenanceAxis } from "../../src/pr-state/cli.ts";
import { resolveCanonicalChainLedger, runReserve } from "../../src/workspace/actor.ts";

const REQUIRE_SIGNED = "PRX_REQUIRE_SIGNED_DERIVATIONS";
// Verifier resolution reads these; clear them so a seeded derivation is
// unverifiable (verifier === null) and the projection fails closed.
const VERIFIER_KEYS = ["PRX_PROVENANCE_PUBKEY", "PRX_PROVENANCE_KEY"] as const;

function sh(cwd: string, file: string, args: string[]): void {
  const r = spawnSync(file, args, { cwd, encoding: "utf8" });
  if ((r.status ?? 1) !== 0) {
    throw new Error(`${file} ${args.join(" ")} (cwd=${cwd}) exit=${r.status}\n${r.stderr ?? ""}`);
  }
}

function makeFixtureRepo(): { repoDir: string; head: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), "merge-guard-prov-"));
  sh(repoDir, "git", ["init", "-b", "main"]);
  sh(repoDir, "git", ["config", "user.email", "test@example.com"]);
  sh(repoDir, "git", ["config", "user.name", "Test"]);
  // Signing off: without it a host with `commit.gpgsign=true` (e.g. SSH
  // signing) hangs this fixture's commit on a signing prompt (#280).
  sh(repoDir, "git", ["config", "commit.gpgsign", "false"]);
  sh(repoDir, "git", ["remote", "add", "origin", "git@github.com:test-owner/test-repo.git"]);
  writeFileSync(join(repoDir, "README"), "hello\n");
  sh(repoDir, "git", ["add", "README"]);
  sh(repoDir, "git", ["commit", "-m", "init"]);
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoDir,
    encoding: "utf8",
  }).stdout.trim();
  return { repoDir, head, cleanup: () => rmSync(repoDir, { recursive: true, force: true }) };
}

const ok: ProcResult = { status: 0, stdout: "", stderr: "", signal: null };
function inner(): ProcExecutor {
  return {
    async exec() {
      return ok;
    },
  };
}

/** Emit one signed push/v1 derivation whose subject is `gitCommit:<oid>`. */
async function seedPush(store: DerivationStore, oid: string): Promise<void> {
  const kp = generateEd25519Keypair();
  const deps: AttestDeps = {
    signer: ed25519Signer(kp.privateKey, kp.keyid),
    store,
    now: () => 1000,
  };
  const exec = attestingProc(inner(), deps, () => ({
    buildType: GIT_PUSH_BUILD_TYPE,
    subject: [{ name: "commit", digest: { gitCommit: oid } }],
  }));
  await exec.exec({ command: "git", args: ["push"] } as ProcRequest);
}

describe("resolveMergeGuardProvenanceAxis canonical ledger wiring (GH-2338)", () => {
  let fixture: ReturnType<typeof makeFixtureRepo>;
  let envSnapshot: Record<string, string | undefined>;

  beforeEach(() => {
    fixture = makeFixtureRepo();
    envSnapshot = {
      [REQUIRE_SIGNED]: process.env[REQUIRE_SIGNED],
      ...Object.fromEntries(VERIFIER_KEYS.map((k) => [k, process.env[k]])),
    };
    for (const k of VERIFIER_KEYS) delete process.env[k];
  });
  afterEach(() => {
    fixture.cleanup();
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function reserve(): void {
    runReserve({ branch: "main", base: "origin/main", local_only: false }, fixture.repoDir);
  }

  test("default-on: flag unset ⇒ enforced (fail closed, same as set)", async () => {
    // Row 6.1: enforcement is now the default. Unset behaves like "1": no
    // reserve ⇒ canonical ledger unresolvable ⇒ block, not pass.
    delete process.env[REQUIRE_SIGNED];
    expect(await resolveMergeGuardProvenanceAxis(fixture.repoDir, undefined)).toBe("unsigned");
  });

  test("opt-out: flag=0 ⇒ undefined regardless of ledger (escape hatch, path unchanged)", async () => {
    process.env[REQUIRE_SIGNED] = "0";
    expect(await resolveMergeGuardProvenanceAxis(fixture.repoDir, undefined)).toBeUndefined();
    // Even reserved + an explicit ledger must stay undefined when opted out.
    reserve();
    const empty = join(fixture.repoDir, "explicit.sqlite");
    expect(await resolveMergeGuardProvenanceAxis(fixture.repoDir, empty)).toBeUndefined();
  });

  test("AC-3: flag set, no --ledger, not a reserved UoW ⇒ fail closed (unsigned)", async () => {
    process.env[REQUIRE_SIGNED] = "1";
    // No reserve: the canonical ledger cannot be resolved → block, not pass.
    expect(await resolveMergeGuardProvenanceAxis(fixture.repoDir, undefined)).toBe("unsigned");
  });

  test("AC-2: explicit --ledger wins over the canonical fallback", async () => {
    process.env[REQUIRE_SIGNED] = "1";
    // Not reserved: a fallback would fail closed ("unsigned"). An explicit empty
    // ledger has no derivation for HEAD ⇒ "unchecked" — proving the override path.
    const explicit = join(fixture.repoDir, "explicit.sqlite");
    expect(await resolveMergeGuardProvenanceAxis(fixture.repoDir, explicit)).toBe("unchecked");
  });

  test("AC-1: reserved UoW, no --ledger, unverifiable derivation in the canonical ledger ⇒ unsigned", async () => {
    process.env[REQUIRE_SIGNED] = "1";
    reserve();
    const canonical = resolveCanonicalChainLedger(fixture.repoDir);
    expect(canonical).not.toBeNull();
    mkdirSync(dirname(canonical!.ledgerPath), { recursive: true });
    const store = openAnchoredChain(canonical!.ledgerPath);
    try {
      await seedPush(store.derivations, fixture.head);
    } finally {
      store.close();
    }
    // No --ledger: the resolver auto-resolves the same canonical ledger, finds a
    // present-but-unverifiable derivation (no verifier configured) ⇒ blocks.
    expect(await resolveMergeGuardProvenanceAxis(fixture.repoDir, undefined)).toBe("unsigned");
  });

  test("auto-resolved canonical ledger with no derivation ⇒ unchecked (fallback opens the right path)", async () => {
    process.env[REQUIRE_SIGNED] = "1";
    reserve();
    // Reserved but nothing emitted: the fallback resolves + opens the canonical
    // ledger, head has no attestation ⇒ "unchecked" (not the fail-closed path).
    expect(await resolveMergeGuardProvenanceAxis(fixture.repoDir, undefined)).toBe("unchecked");
  });
});
