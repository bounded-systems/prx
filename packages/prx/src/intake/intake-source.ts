/**
 * `prx intake source <UoW>` — pin a work unit's source authority as the chain
 * ROOT `<unit>:source@pinned` (GH-232).
 *
 * This is the intake actor OWNING the source pin, instead of it being a
 * side-effect of the plan gate (`checkWorkUnitChain`). Intake holds the
 * capability to reach the source system (gh / bd / notion) and CAS; the planner
 * is sandboxed off those, so it must CONSUME a pre-pinned source rather than
 * fetching (otherwise it fabricates scope — see GH-230). Resolving the source
 * through `resolverForCanonicalId` works uniformly for GitHub, beads, and Notion
 * units, and is idempotent: re-pinning the same source is a no-op by content.
 *
 * Sits upstream of the parity chain (the chain root), so it emits no XState
 * event here — it produces the content-addressed artifact the rest of the
 * pipeline reads.
 */

import { z } from "zod";

import { loadIdentityConfig } from "../pr-state/github.ts";
import { resolverForCanonicalId } from "../pr-state/resolvers/dispatch.ts";
import type { ResolvedWorkUnit } from "../pr-state/resolvers/types.ts";
import { pinWorkUnitSource } from "../pipeline/source-pin.ts";

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
  repoPath?: string;
};

export class IntakeSourceError extends Error {}

/**
 * Resolve the unit's source authority and pin it as `<unit>:source@pinned`.
 * Returns the pinned ref + the resolved source. Pure plumbing — injectable deps
 * keep it testable offline.
 */
export async function runIntakeSource(
  options: IntakeSourceOptions,
  output: Output,
  deps: IntakeSourceDeps = {},
): Promise<number> {
  const loadIdentity = deps.loadIdentity ?? loadIdentityConfig;
  const buildResolver = deps.buildResolver ?? resolverForCanonicalId;
  const pinSource = deps.pinSource ?? pinWorkUnitSource;
  const repoPath = deps.repoPath ?? process.cwd();

  const identity = loadIdentity(repoPath);
  const resolver = buildResolver(options.id, identity, repoPath);
  if (resolver === null) {
    throw new IntakeSourceError(
      `intake source: no source resolver configured for ${options.id} — configure a GitHub/beads/Notion source or check the canonical id`,
    );
  }

  let resolved: ResolvedWorkUnit;
  try {
    resolved = await resolver.fetch(options.id);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new IntakeSourceError(
      `intake source: failed to resolve ${options.id} via ${resolver.name}: ${details}`,
    );
  }

  const { ref } = await pinSource(options.id, resolved);

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
