/**
 * Attesting decorators over the agent write capabilities — Phase A emission.
 *
 * On a successful, attestable capability call, build a SLSA Provenance v1
 * Statement (subject = the artifact produced), sign it via the injected
 * `Signer`, and persist a `Derivation` carrying the signed DSSE `envelope` into
 * the anchored-chain ledger. This is the same decorator-over-port shape as
 * `cachingProcExecutor` (`@bounded-systems/proc`) with a different side effect: where the
 * caching layer acts on a clean *read*, this acts on a clean *write*. Failures
 * and non-attestable calls pass through untouched — no link for a failed or
 * non-producing write, mirroring "only cache `status === 0`".
 *
 * Two surfaces, two subject strategies (spike §3):
 *   - `@bounded-systems/git` commit/push: **self-describing** — the subject is the new
 *     commit, resolved post-success with `rev-parse HEAD`. No caller help.
 *   - `@bounded-systems/proc`: **explicitly opt-in** — the bare executor is not silently
 *     wrapped (most proc runs are reads, not artifact producers); the caller
 *     declares the subject for the runs that produce one.
 *
 * The injected `Signer` comes from outside the extractable core (dev = in-module
 * ed25519; prod = Sigstore keyless, per docs/spikes/sigstore-dsse-signing.md).
 * Enforcement (`requireSigned` in the merge-guard / publisher tier) is a
 * separate follow-up — Phase A only *emits*.
 */

import {
  digestManifest,
  type Derivation,
  type DerivationStore,
  type Digest,
  type Signer,
} from "@bounded-systems/anchored-chain";
import { getAuditRuntimeContext } from "@bounded-systems/audit-context";
import type { execGit, GitExecEnv, GitExecOptions, GitExecResult } from "@bounded-systems/git";
import type { ProcExecutor, ProcRequest, ProcResult } from "@bounded-systems/proc";

import {
  builderId,
  signSlsaStatement,
  slsaProvenanceStatement,
  type SlsaResourceDescriptor,
} from "./slsa.ts";

export const GIT_COMMIT_BUILD_TYPE = "https://prx.dev/git/commit/v1";
export const GIT_PUSH_BUILD_TYPE = "https://prx.dev/git/push/v1";

/** What the decorator needs to emit and persist a signed Derivation. */
export interface AttestDeps {
  /** ed25519 (dev) | Sigstore (prod), injected from outside the core. */
  readonly signer: Signer;
  /** The ledger the signed `Derivation` is appended to. */
  readonly store: Pick<DerivationStore, "append" | "get">;
  /**
   * `runDetails.builder.id`. Defaults to `prx://<actor>/<verb>` from
   * `@bounded-systems/audit-context` at emit time; override for tests / non-CLI callers.
   */
  readonly builderId?: string;
  /** Injected clock so records are deterministic in tests. */
  readonly now?: () => number;
}

/** A subject the caller declares for an opt-in `@bounded-systems/proc` artifact run. */
export interface ProcAttestSubject {
  readonly subject: readonly SlsaResourceDescriptor[];
  readonly buildType: string;
  readonly resolvedDependencies?: readonly SlsaResourceDescriptor[];
  readonly externalParameters?: Readonly<Record<string, unknown>>;
}

/**
 * The attesting git wrapper. `execGit` is synchronous; signing and ledger
 * append are async, so the wrapper returns a `Promise` — the one shape change
 * from the underlying capability. The git result is returned unchanged; the
 * attestation is a pure side effect on success.
 */
export type AttestingGit = (
  opts: GitExecOptions,
  env?: GitExecEnv,
) => Promise<GitExecResult>;

/** Which git subcommands produce an attestable artifact (a new commit/ref). */
export function gitAttestable(opts: GitExecOptions): boolean {
  return opts.subcommand === "commit" || opts.subcommand === "push";
}

function gitBuildType(subcommand: string): string {
  return subcommand === "push" ? GIT_PUSH_BUILD_TYPE : GIT_COMMIT_BUILD_TYPE;
}

/**
 * Wrap `execGit` so a successful commit/push emits a signed SLSA `Derivation`.
 * The subject is self-describing: post-success, resolve `HEAD` via `rev-parse`
 * (a read, allowed in every state/role) → `subject.digest.gitCommit`. If HEAD
 * cannot be resolved the call still succeeds; it simply produces no link rather
 * than a malformed one.
 */
export function attestingGit(
  inner: typeof execGit,
  deps: AttestDeps,
): AttestingGit {
  return async (opts, env) => {
    const result = inner(opts, env);
    if (result.exitCode !== 0 || !gitAttestable(opts)) return result;

    const head = inner(
      { subcommand: "rev-parse", args: ["HEAD"], cwd: opts.cwd },
      env,
    );
    const oid = head.stdout.trim();
    if (head.exitCode !== 0 || oid.length === 0) return result;

    await persistAttestation(deps, {
      buildType: gitBuildType(opts.subcommand),
      subject: [{ name: "commit", digest: { gitCommit: oid } }],
      externalParameters: { subcommand: opts.subcommand, args: opts.args },
    });
    return result;
  };
}

/**
 * Wrap a `ProcExecutor` so explicitly-declared artifact runs emit a signed
 * SLSA `Derivation`. Opt-in by construction: `subjectFor` returns `null` for a
 * run that produces no artifact (the common case — reads), and the wrapper then
 * behaves exactly like the bare executor. Only when the caller declares a
 * subject does a link appear, so wrapping the executor does not silently attest
 * every proc run.
 */
export function attestingProc(
  inner: ProcExecutor,
  deps: AttestDeps,
  subjectFor: (req: ProcRequest, result: ProcResult) => ProcAttestSubject | null,
): ProcExecutor {
  return {
    async exec(req: ProcRequest): Promise<ProcResult> {
      const result = await inner.exec(req);
      if (result.status !== 0) return result;
      const declared = subjectFor(req, result);
      if (declared === null || declared.subject.length === 0) return result;
      await persistAttestation(deps, {
        buildType: declared.buildType,
        subject: declared.subject,
        ...(declared.resolvedDependencies === undefined
          ? {}
          : { resolvedDependencies: declared.resolvedDependencies }),
        ...(declared.externalParameters === undefined
          ? {}
          : { externalParameters: declared.externalParameters }),
      });
      return result;
    },
  };
}

interface AttestationSpec {
  readonly buildType: string;
  readonly subject: readonly SlsaResourceDescriptor[];
  readonly resolvedDependencies?: readonly SlsaResourceDescriptor[];
  readonly externalParameters?: Readonly<Record<string, unknown>>;
}

/**
 * Build the ledger `Derivation` + signed SLSA envelope and append it. The
 * `derivationId` is the content-addressed digest of the manifest (no timestamp
 * inside), so re-emitting an identical attestation is idempotent — the stored
 * record is returned without a duplicate append, mirroring
 * `recordScoutReadDerivation`.
 */
async function persistAttestation(
  deps: AttestDeps,
  spec: AttestationSpec,
): Promise<Derivation> {
  const id = deps.builderId ?? builderId(getAuditRuntimeContext());
  const ts = (deps.now ?? Date.now)();

  const manifest: Derivation["manifest"] = {
    producer: id,
    inputs: descriptorsToDigests(spec.resolvedDependencies ?? []),
    outputs: descriptorsToDigests(spec.subject),
    // Phase B references applied contracts as materials-by-digest; Phase A
    // carries none on the manifest.
    contracts: [],
    params: spec.externalParameters ?? {},
  };
  const derivationId = digestManifest(manifest);

  const existing = await deps.store.get(derivationId);
  if (existing) return existing;

  const statement = slsaProvenanceStatement({
    buildType: spec.buildType,
    builderId: id,
    subject: spec.subject,
    ...(spec.resolvedDependencies === undefined
      ? {}
      : { resolvedDependencies: spec.resolvedDependencies }),
    ...(spec.externalParameters === undefined
      ? {}
      : { externalParameters: spec.externalParameters }),
    invocationId: derivationId as string,
    startedOn: new Date(ts).toISOString(),
  });
  const envelope = await signSlsaStatement(statement, deps.signer);

  const derivation: Derivation = { derivationId, manifest, envelope, ts };
  await deps.store.append(derivation);
  return derivation;
}

/**
 * Project SLSA resource descriptors onto the ledger's `Record<name, Digest>`
 * shape, preserving the digest algorithm in the value (`sha256:<hex>` for CAS
 * content, `gitCommit:<oid>` for a commit). The ledger treats the value as an
 * opaque content key — lineage joins match on exact string equality — so a
 * non-`sha256` algorithm round-trips faithfully while staying internally
 * consistent across a derivation's inputs and outputs.
 */
function descriptorsToDigests(
  descriptors: readonly SlsaResourceDescriptor[],
): Record<string, Digest> {
  const out: Record<string, Digest> = {};
  for (const { name, digest } of descriptors) {
    out[name] = preferredDigest(digest);
  }
  return out;
}

function preferredDigest(set: Readonly<Record<string, string>>): Digest {
  const algos = Object.keys(set).sort();
  // Prefer sha256 (the CAS-native algorithm) when present; else the lowest
  // algorithm name, so the choice is deterministic.
  const alg = algos.includes("sha256") ? "sha256" : algos[0];
  if (alg === undefined) {
    throw new Error("attest: resource descriptor carries no digest");
  }
  return `${alg}:${set[alg]}` as Digest;
}
