// GH-1900: submit-artifact CAS schema + helpers. The submit session prepares
// a deterministic, CAS-backed artifact for a work unit and `prx submit
// publish` consumes it via a CAS ref. Patch bytes go in their own CAS blob
// (so dedup is automatic and the metadata stays small); the metadata JSON
// references the patch sha.

import { z } from "zod";

import {
  DEFAULT_DOMAIN as PLANS_DEFAULT_DOMAIN,
  PlanStoreError,
  readBlob,
  writeBlob,
  type CasSha,
} from "../plan-store/cas.ts";
import { artifactRef, putArtifact } from "../plan-store/artifact-store.ts";

export const SUBMIT_DOMAIN = "submit";

export const SUBMIT_SLOTS = ["draft", "ready", "published"] as const;
export type SubmitSlot = (typeof SUBMIT_SLOTS)[number];

const SHA_RE = /^sha256:[0-9a-f]{64}$/;
const SHA1_RE = /^[0-9a-f]{40}$/;
// prx-gr1: any canonical work-unit id — GH-\d+ (github), prx-xxx / BD-xxx
// (beads), PROJECT-xxx (notion) — not just GitHub. Shape: <prefix>-<suffix>
// with no ref delimiters (`:`/`@`/whitespace), so `<unit>:submit@<slot>` stays
// well-formed. The whole pipeline (source/plan/implement) is already
// unit-id-agnostic; submit was the lone GitHub-only holdout (blocked beads
// units from reaching a PR).
const WORK_UNIT_RE = /^[A-Za-z][A-Za-z0-9_]*-[A-Za-z0-9]+$/;
// `<UoW>:submit@<slot>` — mirrors plan-store ref convention.
const SUBMIT_REF_RE = /^[A-Za-z][A-Za-z0-9_]*-[A-Za-z0-9]+:submit@(draft|ready|published)$/;

export const SubmitArtifactSchema = z
  .object({
    workUnitId: z
      .string()
      .regex(WORK_UNIT_RE, "workUnitId must be a canonical work-unit id (<prefix>-<suffix>)"),
    baseRef: z.string().min(1),
    baseSha: z.string().regex(SHA1_RE, "baseSha must be a 40-char hex"),
    // GH-2381: the artifact's identity is a git TREE SHA — a pure content hash
    // of the staged working state. The branch + commit are NOT stored: they are
    // mutable / time-folded projections keeper materializes at publish
    // (`commit-tree <tree> -p <baseSha>` → derived `GH-<n>` branch). This lets a
    // headless `prx implement` run (which leaves uncommitted edits, never a
    // commit) mint a durable artifact. Replaces the v0 `head:{branch,sha}`.
    tree: z.object({
      sha: z.string().regex(SHA1_RE, "tree.sha must be a 40-char hex"),
    }),
    patch: z.object({
      sha: z.string().regex(SHA_RE, "patch.sha must be a sha256: CAS handle"),
      bytes: z.number().int().nonnegative(),
    }),
    summary: z.string().max(500),
    createdAt: z.string().datetime(),
  })
  .strict();

export type SubmitArtifact = z.infer<typeof SubmitArtifactSchema>;

export function submitRefFor(workUnitId: string, slot: SubmitSlot): string {
  if (!WORK_UNIT_RE.test(workUnitId)) {
    throw new PlanStoreError(
      `submit ref: workUnitId must be a canonical work-unit id <prefix>-<suffix> (got '${workUnitId}')`,
      "INVALID_REF_NAME",
    );
  }
  return artifactRef(workUnitId, "submit", slot);
}

export interface ParsedSubmitRef {
  workUnitId: string;
  slot: SubmitSlot;
}

export function parseSubmitRef(ref: string): ParsedSubmitRef {
  const m = SUBMIT_REF_RE.exec(ref);
  if (!m) {
    throw new PlanStoreError(
      `submit ref: '${ref}' must match <unit>:submit@{draft,ready,published}`,
      "INVALID_REF_NAME",
    );
  }
  const [, slot] = m;
  return {
    workUnitId: ref.split(":")[0]!,
    slot: slot as SubmitSlot,
  };
}

export interface WriteSubmitArtifactInput {
  artifact: SubmitArtifact;
  slot: SubmitSlot;
}

export interface WriteSubmitArtifactResult {
  ref: string;
  sha: CasSha;
}

/**
 * Persist a submit artifact: validates the shape, writes a JSON metadata blob
 * into the `submit` CAS domain, and advances `<UoW>:submit@<slot>` to it.
 * The patch bytes (if any) must already be CAS-resident — the metadata only
 * carries the handle.
 */
export async function writeSubmitArtifact(
  input: WriteSubmitArtifactInput,
): Promise<WriteSubmitArtifactResult> {
  const validated = SubmitArtifactSchema.parse(input.artifact);
  const ref = submitRefFor(validated.workUnitId, input.slot);
  const body = `${JSON.stringify(validated, null, 2)}\n`;
  return putArtifact(ref, body, { domain: SUBMIT_DOMAIN });
}

export interface WritePatchBlobResult {
  sha: CasSha;
  bytes: number;
}

/**
 * Write the raw patch bytes (e.g. `git format-patch` output) into the submit
 * CAS domain so the artifact metadata can reference it via {sha, bytes}.
 */
export async function writeSubmitPatchBlob(patch: string | Buffer): Promise<WritePatchBlobResult> {
  const buf = typeof patch === "string" ? Buffer.from(patch, "utf8") : patch;
  const { sha } = await writeBlob(buf, { domain: SUBMIT_DOMAIN });
  return { sha, bytes: buf.length };
}

export interface ReadSubmitArtifactInput {
  ref?: string;
  sha?: CasSha;
}

/**
 * Read and validate a submit artifact. Accepts either a `<UoW>:submit@<slot>`
 * ref or a raw `sha256:...` CAS handle. The caller resolves the ref → sha
 * indirection upstream when needed (via `getRef`); this helper expects the
 * sha when no ref is provided.
 */
export async function readSubmitArtifact(input: ReadSubmitArtifactInput): Promise<SubmitArtifact> {
  if (!input.sha) {
    throw new PlanStoreError(
      "readSubmitArtifact: sha is required (resolve ref → sha via getRef)",
      "INVALID_SHA",
    );
  }
  const buf = await readBlob(input.sha, { domain: SUBMIT_DOMAIN });
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString("utf8"));
  } catch (err) {
    throw new PlanStoreError(
      `submit artifact at ${input.sha} is not valid JSON: ${(err as Error).message}`,
      "BLOB_CORRUPT",
    );
  }
  return SubmitArtifactSchema.parse(parsed);
}

// Guard so callers that mistype the domain constant trip a clear failure
// instead of silently writing into the plans store. The comparison is via
// `String()` so the type-narrowing on `SUBMIT_DOMAIN` doesn't elide the check.
if (String(SUBMIT_DOMAIN) === String(PLANS_DEFAULT_DOMAIN)) {
  throw new Error(
    "submit/artifact.schema.ts: SUBMIT_DOMAIN must not collide with plans default domain",
  );
}
