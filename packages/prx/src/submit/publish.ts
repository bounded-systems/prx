// GH-1900: `prx submit publish --from-cas <ref>` — consumer of the
// work-unit-bound submit-session artifact. Reads the CAS-backed artifact,
// runs the parity preflight, pushes the head branch, opens the PR, and
// advances `<UoW>:submit@<slot>` to `<UoW>:submit@published`.
//
// GH-2381: the artifact records a git TREE SHA, not a committed head. Keeper
// materializes the publishable commit at publish time (`commit-tree <tree> -p
// <baseSha>`, pinned dates) and the branch (`GH-<n>`) is derived from the work
// unit — neither is stored. Patch bytes are recorded for portability but not
// applied (the patch-replay path lands later).

import type { Derivation, Verifier } from "@bounded-systems/anchored-chain";
import { spawnCapture } from "@bounded-systems/proc";

import { getRef, PlanStoreError, setRef, type CasSha } from "../plan-store/cas.ts";
import { type AttestDeps } from "../provenance/attest.ts";
import { loadOrCreateCommitSigningKey } from "../provenance/commit-signing-key.ts";
import { verifySlsaDerivation } from "../provenance/verify.ts";
import {
  isL3Attestation,
  verifyL3Attestation,
  type L3Attestation,
} from "../provenance/verify-l3.ts";
import { verifyLaunchChain, type LaunchAttestation } from "../provenance/verify-chain.ts";
import { resolveLaunchAttestationFromCas } from "../provenance/launch-store.ts";
import { resolveKeeperTrustKey, resolveLauncherTrustKey } from "../provenance/keeper-trust.ts";
// GH-2348.2: submit-publish is now an orchestrator — it delegates the push to
// keeper (attesting) and the PR-open to publisher, keeping only artifact
// resolution, the relocated requireSigned verify gate, and the slot advance.
import { runKeeperCommitTree, runKeeperPush } from "../pr-state/keeper.ts";
import { isKeeperDoorMode } from "../keeperd/endpoint.ts";
import { runKeeperDoorPush } from "../keeperd/host.ts";
import { runPrOpen } from "../pr-state/publisher.ts";
import type { DoctorOutput, DoctorTarget } from "../pr-state/doctor.ts";
import {
  parseSubmitRef,
  readSubmitArtifact,
  submitRefFor,
  SUBMIT_DOMAIN,
  type SubmitArtifact,
} from "./artifact.schema.ts";

export interface PublishOptions {
  fromCas: string;
  dryRun: boolean;
  format: "plain" | "json";
  /**
   * Open the PR ready-for-review instead of draft. Default (false) opens a
   * draft so a CI-pending PR never lands ready — the "never ready while CI is
   * running" rule. Set true only when CI is known-green (GH-2267).
   */
  ready: boolean;
}

export interface PublishStep {
  // GH-2348.2: push/PR are now delegated (keeper push, publisher pr open)
  // rather than inline git/gh argv steps.
  kind: "keeper-commit" | "keeper-push" | "publisher-pr-open" | "set-ref" | "preflight";
  argv?: string[];
  ref?: string;
  sha?: CasSha;
  detail?: string;
}

export interface PublishRender {
  fromCas: string;
  artifact: SubmitArtifact;
  resolvedSha: CasSha;
  steps: PublishStep[];
  dryRun: boolean;
  exitCode: number;
}

export class PublishError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "PublishError";
    this.exitCode = exitCode;
  }
}

type Runner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
) => { status: number | null; stdout: string; stderr: string };

const defaultRunner: Runner = (cmd, args, opts) =>
  spawnCapture([cmd, ...args], opts?.cwd !== undefined ? { cwd: opts.cwd } : {});

export interface PublishDeps {
  /** Runs `git`/`gh`/`prx` subprocesses. Tests stub this. */
  runner?: Runner;
  /** Resolves a `<UoW>:submit@<slot>` ref → sha. Defaults to plan-store getRef. */
  getRef?: typeof getRef;
  /** Reads + validates an artifact by sha. Defaults to schema helper. */
  readSubmitArtifact?: typeof readSubmitArtifact;
  /** Advances the published-slot ref. Defaults to plan-store setRef. */
  setRef?: typeof setRef;
  /**
   * When present, a successful push emits a signed SLSA Provenance v1
   * `push/v1` derivation (subject = the pushed commit) into the injected
   * ledger. Absent ⇒ no emission. Emission is best-effort/fail-open: a signer
   * or ledger failure never fails `prx submit publish` (GH-2269; enforcement is
   * the downstream GH-2249 concern).
   */
  attest?: AttestDeps;
  /**
   * GH-2249 publisher-tier enforcement (I-PROV1). When true, a successful push
   * must have emitted a derivation that verifies under {@link verifier} before
   * the PR is opened — an unsigned / unverifiable push fails closed (no
   * `gh pr create`). Resolved at the CLI handler from
   * `PRX_REQUIRE_SIGNED_DERIVATIONS`; the core function stays env-free. Absent
   * or false ⇒ behaviour is identical to today (no verification).
   */
  requireSigned?: boolean;
  /**
   * The `Verifier` enforcement checks the emitted derivation against (resolved
   * at the CLI handler from `PRX_PROVENANCE_PUBKEY`). Required when
   * {@link requireSigned} is true; its absence under enforcement fails closed.
   */
  verifier?: Verifier;
  /**
   * Resolve the OPERATOR-supplied keeper trust key (PEM) for verifying the door
   * (door-keeper) path's L3 attestation. Defaults to {@link resolveKeeperTrustKey}
   * (`PRX_KEEPER_PUBKEY`). NEVER derived from the actor; null ⇒ fail closed under
   * {@link requireSigned} in door mode. Tests inject a fixed key.
   */
  resolveKeeperKey?: typeof resolveKeeperTrustKey;
  /**
   * Resolve the OPERATOR-supplied launcher trust key (PEM) — `PRX_LAUNCH_PUBKEY`,
   * via {@link resolveLauncherTrustKey}. When non-null, **capability-chain
   * enforcement is on**: the door L3 must link to a verifiable L2 launch. Null ⇒
   * chain enforcement is skipped (opt-in). Tests inject a fixed key.
   */
  resolveLauncherKey?: typeof resolveLauncherTrustKey;
  /**
   * Fetch the L2 launch attestation the given L3 links to (by its content-address)
   * — e.g. from the anchored-chain ledger. Returns null if absent (→ fail closed
   * under chain enforcement). Tests inject the L2; the live CAS resolver + the
   * launch-flow that stores the L2 are the producer capstone.
   */
  resolveLaunchAttestation?: (l3: L3Attestation) => Promise<LaunchAttestation | null>;
  // GH-2348.2: delegation seams. submit-publish orchestrates the side effects
  // through the effect roles rather than running git/gh itself.
  /** Keeper's attesting push (defaults to the real `runKeeperPush`). */
  keeperPush?: typeof runKeeperPush;
  /**
   * Box profile (prx-asr): when `isKeeperDoorMode()` (the projected
   * `PRX_KEEPER_DOOR`), route the push through the keeperd door instead of a
   * local push — the host bundles the materialized commit range and the daemon
   * imports + signed-pushes it (the host holds no push credential / signing key).
   * `keeperDoorMode` + `keeperDoor` are injected in tests; `keeperLedgerRef` is
   * the ledger the daemon signs `push/v1` into (its `signedDerivation` is what
   * the requireSigned gate then verifies).
   */
  keeperDoorMode?: () => boolean;
  keeperDoor?: typeof runKeeperDoorPush;
  keeperLedgerRef?: string;
  /**
   * GH-2381: keeper's commit-tree materialization (defaults to the real
   * `runKeeperCommitTree`). Synthesizes the publishable commit from the
   * artifact's tree SHA + base, derives + checks out the branch, and returns
   * the materialized commit SHA (the provenance subject for the push).
   */
  commitTree?: typeof runKeeperCommitTree;
  /** Publisher's PR-open (defaults to the real `runPrOpen`). */
  prOpen?: typeof runPrOpen;
}

/**
 * GH-2381: the work-unit branch is a derived projection (`GH-<n>`), not stored
 * in the artifact. Keeper points it at the materialized commit at publish.
 */
function derivedBranch(workUnitId: string): string {
  return workUnitId;
}

/** Synthetic commit message keeper wraps the tree in (subject + lineage tag). */
function syntheticCommitMessage(artifact: SubmitArtifact): string {
  return `${artifact.summary}\n\n${artifact.workUnitId}`;
}

/**
 * Resolve the `--from-cas` value to a CAS sha. Accepts:
 *   - `<UoW>:submit@{draft,ready,published}` — looked up in the submit domain
 *   - `sha256:<64hex>` — used directly
 */
async function resolveFromCas(
  fromCas: string,
  deps: { getRef: typeof getRef },
): Promise<{ sha: CasSha; viaRef: string | null }> {
  if (fromCas.startsWith("sha256:")) {
    return { sha: fromCas as CasSha, viaRef: null };
  }
  const { workUnitId: _wu, slot: _slot } = parseSubmitRef(fromCas);
  const sha = await deps.getRef(fromCas, { domain: SUBMIT_DOMAIN });
  if (sha === null) {
    throw new PublishError(`prx submit publish: ref '${fromCas}' not found in submit CAS domain`);
  }
  return { sha, viaRef: fromCas };
}

export async function runSubmitPublish(
  opts: PublishOptions,
  deps: PublishDeps = {},
): Promise<PublishRender> {
  const runner = deps.runner ?? defaultRunner;
  const getRefFn = deps.getRef ?? getRef;
  const readArtifact = deps.readSubmitArtifact ?? readSubmitArtifact;
  const setRefFn = deps.setRef ?? setRef;

  const { sha } = await resolveFromCas(opts.fromCas, { getRef: getRefFn });
  let artifact: SubmitArtifact;
  try {
    artifact = await readArtifact({ sha });
  } catch (err) {
    if (err instanceof PlanStoreError) {
      throw new PublishError(`prx submit publish: failed to read artifact ${sha}: ${err.message}`);
    }
    throw err;
  }

  const preflightArgv = ["prx", "chain", "check-issue", artifact.workUnitId];
  const branch = derivedBranch(artifact.workUnitId);
  const pushArgs = ["origin", branch];
  // For the dry-run plan only; runPrOpen builds the real `(GH-N)` title itself.
  const prTitle = `${artifact.summary} (${artifact.workUnitId})`.slice(0, 200);
  const publishedRef = submitRefFor(artifact.workUnitId, "published");

  const steps: PublishStep[] = [
    { kind: "preflight", argv: preflightArgv },
    {
      kind: "keeper-commit",
      detail: `commit-tree ${artifact.tree.sha.slice(0, 8)} -p ${artifact.baseSha.slice(0, 8)} → ${branch}`,
    },
    { kind: "keeper-push", argv: ["prx", "keeper", "push", ...pushArgs] },
    {
      kind: "publisher-pr-open",
      detail: `${prTitle}${opts.ready ? "" : " (draft)"}`,
    },
    { kind: "set-ref", ref: publishedRef, sha },
  ];

  if (opts.dryRun) {
    return {
      fromCas: opts.fromCas,
      artifact,
      resolvedSha: sha,
      steps,
      dryRun: true,
      exitCode: 0,
    };
  }

  // 1. Parity preflight — branch/worktree/sha alignment.
  const preflight = runner(preflightArgv[0]!, preflightArgv.slice(1));
  if (preflight.status !== 0) {
    const tail = (preflight.stderr ?? "").trim().split("\n").slice(-1)[0] ?? "";
    throw new PublishError(
      `prx submit publish: parity preflight failed (${preflight.status}) ${tail}`.trim(),
    );
  }

  // 1b. GH-2381: keeper materializes the publishable commit from the artifact's
  // tree SHA + base commit (pinned dates → reproducible SHA), points the derived
  // `GH-<n>` branch at it, and checks it out so it is HEAD before the push. The
  // commit + branch are NOT stored in the artifact — keeper derives them here.
  const commitTree = deps.commitTree ?? runKeeperCommitTree;
  let materializedCommit: string;
  try {
    materializedCommit = await commitTree(
      {
        treeSha: artifact.tree.sha,
        parentSha: artifact.baseSha,
        message: syntheticCommitMessage(artifact),
        date: artifact.createdAt,
        branch,
      },
      undefined,
      // prx-e7cl: the direct keeper path signs with prx's OWN internal key
      // (generate-on-first-use), so the materialized commit is verified at
      // creation and the keeper's fail-closed guard has a signature to check.
      { signingKeyPath: () => loadOrCreateCommitSigningKey().privateKeyPath },
    );
  } catch (err) {
    throw new PublishError(
      `prx submit publish: keeper commit-materialize failed: ${(err as Error).message}`,
    );
  }

  // 2. Push the head branch via keeper (role=keeper). When provenance deps are
  // injected, `runKeeperPush` wraps the push with `attestingGit`, emitting a
  // signed SLSA `push/v1` derivation. GH-2249 enforcement reads what was
  // *persisted*, so capture the emitted derivation by decorating the ledger
  // `append` (no core change to `attest`).
  // Captured via a const array (not a closure-mutated `let`) so the emitted
  // derivation reads back with a clean `Derivation` type for the verify gate.
  const capturedDerivations: Derivation[] = [];
  const pushAttest: AttestDeps | undefined = deps.attest
    ? {
        ...deps.attest,
        store: {
          get: (id) => deps.attest!.store.get(id),
          async append(d) {
            await deps.attest!.store.append(d);
            capturedDerivations.push(d);
          },
        },
      }
    : undefined;
  // Off-box (default) this is a local attesting push. In the box profile
  // (`PRX_KEEPER_DOOR`, prx-asr) it routes through the keeperd door: the host
  // bundles the materialized commit range and the daemon imports + signed-pushes
  // it (the host holds no push credential / signing key). Either way `signed` is
  // the push's `push/v1` derivation — host-captured locally, or returned by the
  // daemon over the door — which the GH-2249 gate below verifies.
  const inDoorMode = (deps.keeperDoorMode ?? isKeeperDoorMode)();
  let signed: Derivation | L3Attestation | null;
  if (inDoorMode) {
    const keeperDoor = deps.keeperDoor ?? runKeeperDoorPush;
    const resp = await keeperDoor({
      cwd: process.cwd(),
      parentSha: artifact.baseSha,
      commitSha: materializedCommit,
      branch,
      remote: "origin",
      ...(deps.keeperLedgerRef !== undefined ? { ledgerRef: deps.keeperLedgerRef } : {}),
    });
    if (resp.status === "error") {
      throw new PublishError(
        `prx submit publish: keeper door push failed (${resp.code}) ${resp.message}`.trim(),
      );
    }
    // The daemon must have imported + pushed exactly the commit we materialized
    // (its own seam verifies the imported tip equals commitSha before pushing).
    if (resp.commitSha !== materializedCommit) {
      throw new PublishError(
        `prx submit publish: keeper door push reports ${resp.commitSha}, not the materialized commit ${materializedCommit}`,
      );
    }
    signed = (resp.signedDerivation as L3Attestation | undefined) ?? null;
  } else {
    const keeperPush = deps.keeperPush ?? runKeeperPush;
    const push = await keeperPush(pushArgs, undefined, pushAttest ? { attest: pushAttest } : {});
    if (push.exitCode !== 0) {
      const tail = (push.stderr ?? "").trim().split("\n").slice(-1)[0] ?? "";
      throw new PublishError(
        `prx submit publish: keeper push failed (${push.exitCode}) ${tail}`.trim(),
      );
    }
    // The last derivation the push appended (recorded by the ledger-append
    // closure); null if nothing was emitted.
    signed = capturedDerivations.at(-1) ?? null;
  }

  // 2b. GH-2249 publisher-tier enforcement (I-PROV1). When `requireSigned`, the
  // push must have emitted a derivation that verifies under the resolved verifier
  // — fail closed BEFORE `gh pr create` so an unsigned / tampered push never opens
  // a PR. Absent the flag this block is skipped, so behaviour is identical to
  // today. The push side effect has already happened; failing here blocks PR
  // creation but does not (and cannot) unwind the push.
  if (deps.requireSigned) {
    if (signed === null) {
      throw new PublishError(
        "prx submit publish: signed-derivation enforcement is on by default but the push emitted no signed attestation (no signer/ledger configured) — configure a signer, or opt out with PRX_REQUIRE_SIGNED_DERIVATIONS=0",
      );
    }
    if (isL3Attestation(signed)) {
      // door-keeper L3 path (branch on the attestation FORMAT, so prx's own
      // push/v1 daemon and door-keeper's L3 both work during the transition):
      // verify the L3 against the OPERATOR-supplied keeper trust key — never the
      // actor's own key. Fail closed when the key is unconfigured.
      // verifyL3Attestation also enforces subject == the materialized commit.
      const keeperKey = (deps.resolveKeeperKey ?? resolveKeeperTrustKey)();
      if (keeperKey === null) {
        throw new PublishError(
          "prx submit publish: signed-derivation enforcement is on by default but no keeper trust key is configured (set PRX_KEEPER_PUBKEY, or opt out with PRX_REQUIRE_SIGNED_DERIVATIONS=0)",
        );
      }
      if (!verifyL3Attestation(signed, keeperKey, materializedCommit)) {
        throw new PublishError(
          "prx submit publish: signed-attestation enforcement failed — the door-keeper L3 does not verify against the configured keeper key, or attests the wrong commit",
        );
      }
      // Capability-chain enforcement (opt-in): when a LAUNCHER trust key is
      // configured, the L3 write must link back to a verifiable L2 launch — so
      // the write provably came from an attested launch, not the host's claim.
      const launcherKey = (deps.resolveLauncherKey ?? resolveLauncherTrustKey)();
      if (launcherKey !== null) {
        const l2 = await (deps.resolveLaunchAttestation ?? resolveLaunchAttestationFromCas)(signed);
        if (l2 === null) {
          throw new PublishError(
            "prx submit publish: launch-chain enforcement failed — no L2 launch attestation found for the write's launch link",
          );
        }
        if (
          !verifyLaunchChain({
            l3: signed,
            l2,
            keeperKeyPem: keeperKey,
            launcherKeyPem: launcherKey,
            expectedCommit: materializedCommit,
          })
        ) {
          throw new PublishError(
            "prx submit publish: launch-chain enforcement failed — the L3 write does not chain to a verifiable L2 launch under the configured launcher key",
          );
        }
      }
    } else {
      // Local path: an anchored-chain DSSE `push/v1` derivation.
      if (deps.verifier === undefined) {
        throw new PublishError(
          "prx submit publish: signed-derivation enforcement is on by default but no provenance verifier is configured (set PRX_PROVENANCE_PUBKEY, or opt out with PRX_REQUIRE_SIGNED_DERIVATIONS=0)",
        );
      }
      const derivation = signed as Derivation;
      // GH-2348.2 / GH-2381 subject-equality defense: the push attests a commit; it
      // must equal the commit keeper just materialized from the tree artifact.
      if (derivation.manifest.outputs.commit !== `gitCommit:${materializedCommit}`) {
        throw new PublishError(
          `prx submit publish: signed-derivation enforcement failed — push attests ${String(derivation.manifest.outputs.commit)}, not the materialized commit gitCommit:${materializedCommit}`,
        );
      }
      if (!(await verifySlsaDerivation(derivation, deps.verifier))) {
        throw new PublishError(
          "prx submit publish: signed-derivation enforcement failed — the emitted push derivation does not verify under the configured verifier",
        );
      }
    }
  }

  // 3. Open the PR via publisher (forge). runPrOpen builds the `(GH-N)` title +
  // `Closes #N` body and runs `gh pr create` (draft unless --ready).
  const prLines: string[] = [];
  const prOutput: DoctorOutput = {
    log: (line: string) => prLines.push(line),
    error: (line: string) => prLines.push(line),
  };
  const prTarget: DoctorTarget = {
    workUnitId: artifact.workUnitId,
    repoPath: process.cwd(),
  };
  const prOpen = deps.prOpen ?? runPrOpen;
  const prCode = prOpen(
    prTarget,
    {
      summary: artifact.summary,
      head: branch,
      base: artifact.baseRef,
      ready: opts.ready,
    },
    opts.format,
    prOutput,
  );
  if (prCode !== 0) {
    throw new PublishError(
      `prx submit publish: publisher pr open failed (${prCode}) ${prLines.join(" ").trim()}`.trim(),
    );
  }

  // 4. Advance the published-slot ref to the artifact sha.
  await setRefFn(publishedRef, sha, { domain: SUBMIT_DOMAIN });

  return {
    fromCas: opts.fromCas,
    artifact,
    resolvedSha: sha,
    steps,
    dryRun: false,
    exitCode: 0,
  };
}

export function formatPublishRender(render: PublishRender, format: "plain" | "json"): string {
  if (format === "json") {
    return JSON.stringify(render, null, 2);
  }
  const lines: string[] = [];
  lines.push(`prx submit publish: ${render.dryRun ? "DRY RUN " : ""}${render.artifact.workUnitId}`);
  lines.push(`  from-cas: ${render.fromCas}`);
  lines.push(`  sha: ${render.resolvedSha}`);
  lines.push(`  base: ${render.artifact.baseRef}@${render.artifact.baseSha}`);
  lines.push(`  tree: ${render.artifact.tree.sha}`);
  lines.push(`  branch: ${derivedBranch(render.artifact.workUnitId)} (derived)`);
  for (const step of render.steps) {
    if (step.argv) {
      lines.push(`  ${step.kind}: ${step.argv.join(" ")}`);
    } else if (step.ref && step.sha) {
      lines.push(`  ${step.kind}: ${step.ref} → ${step.sha}`);
    } else if (step.detail) {
      lines.push(`  ${step.kind}: ${step.detail}`);
    }
  }
  return lines.join("\n");
}
