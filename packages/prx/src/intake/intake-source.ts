/**
 * `prx intake source <UoW>` — pin a work unit's source authority as the chain
 * ROOT `<unit>:source@pinned` (GH-232).
 *
 * Capability split (ocap): the FETCH (reaching gh/bd/notion) is `scout`'s — see
 * `resolveWorkUnitSource` in `../scout/source.ts` — because scout owns external
 * reads. This verb delegates the fetch to scout and OWNS the ATTENUATION: it
 * pins scout's resolved result into the content-addressed `<unit>:source@pinned`
 * artifact (the chain root). The planner is sandboxed off gh/bd/notion, so it
 * CONSUMES this pinned artifact as input — it never fetches/hydrates (GH-230).
 * Idempotent: re-pinning the same source is a no-op by content.
 *
 * Sits upstream of the parity chain (the chain root), so it emits no XState
 * event here — it produces the content-addressed artifact the rest of the
 * pipeline reads.
 */

import { z } from "zod";

import { loadIdentityConfig } from "../pr-state/github.ts";
import { resolverForCanonicalId } from "../pr-state/resolvers/dispatch.ts";
import { resolveWorkUnitSource, ScoutSourceError } from "../scout/source.ts";
import { pinWorkUnitSource } from "../pipeline/source-pin.ts";
import { requireSigner } from "../cli/agent-signing-guard.ts";
import { realStatementSigner } from "../machine/machines/pilot-signing.ts";
import type { StatementSigner } from "../machine/machines/provenance.ts";

export const intakeSourceOptionsSchema = z.object({
  id: z.string().trim().min(1, "id must not be empty"),
  format: z.enum(["plain", "json"]).default("plain"),
});

export type IntakeSourceOptions = z.infer<typeof intakeSourceOptionsSchema>;

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

export type IntakeSourceDeps = {
  loadIdentity?: typeof loadIdentityConfig;
  buildResolver?: typeof resolverForCanonicalId;
  pinSource?: typeof pinWorkUnitSource;
  /**
   * The submitting actor's signer. GH-292: intake signs the input text — the
   * signature IS the root artifact. Defaults to the ambient key-gated signer
   * (`requireSigner`), so a missing key is a hard refusal. Tests inject a stub.
   */
  signer?: StatementSigner;
  repoPath?: string;
};

export class IntakeSourceError extends Error {}

/**
 * Delegate the fetch to scout, then pin the result as a SIGNED `<unit>:source@pinned`.
 * The submitting actor signs the input text (GH-292). Returns the pinned ref +
 * the resolved source. Injectable deps keep it testable offline.
 */
export async function runIntakeSource(
  options: IntakeSourceOptions,
  output: Output,
  deps: IntakeSourceDeps = {},
): Promise<number> {
  const pinSource = deps.pinSource ?? pinWorkUnitSource;
  // GH-292: no unsigned intake. The submitting actor must hold a signing key —
  // `requireSigner` refuses otherwise. Tests inject `deps.signer`.
  const signer = deps.signer ?? realStatementSigner(requireSigner("intake"));

  // GH-232: scout owns the reach — delegate the fetch, don't resolve here.
  let resolved;
  try {
    resolved = await resolveWorkUnitSource(options.id, {
      ...(deps.loadIdentity ? { loadIdentity: deps.loadIdentity } : {}),
      ...(deps.buildResolver ? { buildResolver: deps.buildResolver } : {}),
      ...(deps.repoPath ? { repoPath: deps.repoPath } : {}),
    });
  } catch (error) {
    // Re-wrap scout's error under the intake verb's surface for the caller.
    if (error instanceof ScoutSourceError) throw new IntakeSourceError(error.message);
    throw error;
  }

  const { ref } = await pinSource(options.id, resolved, signer);

  if (options.format === "json") {
    output.log(
      JSON.stringify({
        unit: options.id,
        ref,
        source: resolved.source,
        title: resolved.title,
        state: resolved.state,
      }),
    );
  } else {
    output.log(`pinned ${ref}`);
    output.log(`  source=${resolved.source} state=${resolved.state} title=${resolved.title}`);
  }
  return 0;
}
