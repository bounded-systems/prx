/**
 * The signed SLSA-v1 spawn attestation (GH-293) — the ocap that makes
 * "no agent runs without its input artifact" cryptographically load-bearing.
 *
 * Spawning a leg is a SLSA build step: the builder is the prx-claude runtime for
 * that role (`prx-claude://<role>`), the **materials** (`resolvedDependencies`)
 * are the consumed input artifact `{uri, sha256}`, and the subject is the leg
 * identity. You cannot mint this statement without the input artifact's digest,
 * the launch path refuses to run the agent unless the mint succeeds, and the
 * persisted `<unit>:spawn@<role>` is independently verifiable. The attestation
 * IS the capability token.
 *
 * Reuses the existing in-toto / DSSE / ed25519 stack (`StatementSigner`,
 * `verifyStatement`) — no new crypto.
 */
import { z } from "zod";

import {
  IN_TOTO_STATEMENT_TYPE,
  sha256Hex,
  type StatementSigner,
  type Subject,
} from "../machine/machines/provenance.ts";
import { verifyStatement, type Verifier } from "../machine/machines/pilot-signing.ts";
import {
  type ArtifactEdge,
  type EmitResult,
  consumeArtifact,
  defineEdge,
  emitArtifact,
} from "./edge.ts";

/** The SLSA provenance predicate type — the spawn attestation's predicateType. */
export const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";
/** The prx spawn buildType — identifies this as a leg launch. */
export const PRX_SPAWN_BUILD_TYPE = "https://prx.bounded.systems/spawn/v1";

const digestSchema = z.object({ sha256: z.string().min(1) });

/** The SLSA-v1 statement persisted at `<unit>:spawn@<role>`. */
export const spawnStatementSchema = z.object({
  _type: z.literal(IN_TOTO_STATEMENT_TYPE),
  subject: z.array(z.object({ name: z.string(), digest: digestSchema })).min(1),
  predicateType: z.literal(SLSA_PROVENANCE_V1),
  predicate: z.object({
    buildDefinition: z.object({
      buildType: z.string(),
      externalParameters: z.record(z.string(), z.unknown()),
      internalParameters: z.record(z.string(), z.unknown()),
      resolvedDependencies: z.array(z.object({ uri: z.string(), digest: digestSchema })).min(1),
    }),
    runDetails: z.object({
      builder: z.object({ id: z.string() }),
      metadata: z.record(z.string(), z.unknown()),
    }),
  }),
  signedBy: z.string(),
  sig: z.string(),
});
export type SpawnStatement = z.infer<typeof spawnStatementSchema>;

/** The edge for a role's spawn attestation: `<unit>:spawn@<role>`. */
export function spawnEdge(role: string): ArtifactEdge<SpawnStatement> {
  return defineEdge({
    kind: "spawn",
    slot: role,
    source: role,
    target: "runtime",
    persistence: "cas",
    schema: spawnStatementSchema,
  });
}

/** The consumed input artifact a spawn binds to (its sole material). */
export type SpawnInput = { ref: string; sha: string };

export type BuildSpawnArgs = {
  unit: string;
  /** The role/actor being spawned (the `spawn@<role>` slot). */
  role: string;
  /** The launching actor identity (recorded in externalParameters). */
  actor: string;
  /** The consumed input artifact — the spawn's required material. */
  input: SpawnInput;
  /** headless | interactive (recorded for audit). */
  interaction?: string | undefined;
  /** Opaque per-launch correlation id (e.g. the session branch). */
  invocationId?: string | undefined;
};

/**
 * Deterministic leg-identity digest: the subject of the spawn statement. Binds
 * (unit, role, input material) so the statement is mintable before the agent
 * profile exists, yet is unique per leg + input.
 */
function legIdentityDigest(args: BuildSpawnArgs): string {
  return sha256Hex(
    JSON.stringify({ unit: args.unit, role: args.role, inputRef: args.input.ref, inputSha: args.input.sha }),
  );
}

/** The signable (predicateType, subject, predicate) for a spawn. */
export function spawnStatementArgs(args: BuildSpawnArgs): {
  predicateType: string;
  subject: Subject[];
  predicate: Record<string, unknown>;
} {
  return {
    predicateType: SLSA_PROVENANCE_V1,
    subject: [{ name: `${args.unit}:${args.role}@spawn`, digest: { sha256: legIdentityDigest(args) } }],
    predicate: {
      buildDefinition: {
        buildType: PRX_SPAWN_BUILD_TYPE,
        externalParameters: {
          workUnitId: args.unit,
          role: args.role,
          actor: args.actor,
          ...(args.interaction !== undefined ? { interaction: args.interaction } : {}),
        },
        internalParameters: {},
        // The ocap material: the leg's consumed input artifact, by content digest.
        resolvedDependencies: [{ uri: args.input.ref, digest: { sha256: args.input.sha } }],
      },
      runDetails: {
        builder: { id: `prx-claude://${args.role}` },
        metadata: { ...(args.invocationId !== undefined ? { invocationId: args.invocationId } : {}) },
      },
    },
  };
}

/**
 * Build, sign, and PERSIST the spawn attestation at `<unit>:spawn@<role>`. The
 * material (`input.sha`) is required — there is no spawn statement without the
 * consumed input. Returns the signed statement + the emit result.
 */
export async function mintSpawnAttestation(
  args: BuildSpawnArgs,
  signer: StatementSigner,
): Promise<{ statement: SpawnStatement; emit: EmitResult }> {
  if (!args.input.sha || args.input.sha.length === 0) {
    throw new Error(`mintSpawnAttestation(${args.unit}/${args.role}): no input material — cannot spawn`);
  }
  const sArgs = spawnStatementArgs(args);
  const { signedBy, sig } = await signer(sArgs);
  // Parse to narrow the loosely-typed args onto the literal SpawnStatement type
  // (and validate the shape before it is persisted).
  const statement = spawnStatementSchema.parse({ _type: IN_TOTO_STATEMENT_TYPE, ...sArgs, signedBy, sig });
  const emit = await emitArtifact(spawnEdge(args.role), args.unit, statement);
  return { statement, emit };
}

export type VerifySpawnResult =
  | { ok: true; statement: SpawnStatement }
  | { ok: false; reason: "missing" | "unreadable" | "bad-signature" | "material-mismatch" };

/**
 * Verify a persisted spawn attestation: the signature round-trips against
 * `verifier`, and (when `expectedInputSha` is given) its sole material still
 * matches the currently-pinned input — proving the leg was launched on exactly
 * the input that is pinned now.
 */
export async function verifySpawn(
  unit: string,
  role: string,
  verifier: Verifier,
  opts: { expectedInputSha?: string } = {},
): Promise<VerifySpawnResult> {
  let got;
  try {
    got = await consumeArtifact(spawnEdge(role), unit);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (got.missing || !got.value) return { ok: false, reason: "missing" };
  const st = got.value;
  const sigOk = await verifyStatement(verifier, {
    _type: st._type,
    predicateType: st.predicateType,
    subject: st.subject,
    predicate: st.predicate,
    signedBy: st.signedBy,
    sig: st.sig,
  });
  if (!sigOk) return { ok: false, reason: "bad-signature" };
  if (opts.expectedInputSha !== undefined) {
    const dep = st.predicate.buildDefinition.resolvedDependencies[0];
    if (!dep || dep.digest.sha256 !== opts.expectedInputSha) {
      return { ok: false, reason: "material-mismatch" };
    }
  }
  return { ok: true, statement: st };
}
