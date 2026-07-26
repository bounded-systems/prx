/**
 * `prx scout source <UoW>` — resolve a work unit's source authority (the GH
 * issue / beads row / Notion ticket).
 *
 * GH-232 (ocap): scout OWNS external reads (gh/bd/notion), so the source FETCH
 * (the reach) lives here — not in intake. Giving intake the resolver reach was
 * an ocap layering violation (ambient external-read authority it shouldn't
 * hold). The capability flow is: `scout` fetches (this module) → the pin step
 * (intake) attenuates the result into the content-addressed `<unit>:source@pinned`
 * → `plan` consumes it as input. This verb only RESOLVES; it does not pin.
 */

import { z } from "zod";

import { loadIdentityConfig } from "../pr-state/github.ts";
import { resolverForCanonicalId } from "../pr-state/resolvers/dispatch.ts";
import type { ResolvedWorkUnit } from "../pr-state/resolvers/types.ts";

export const scoutSourceOptionsSchema = z.object({
  id: z.string().trim().min(1, "id must not be empty"),
  format: z.enum(["plain", "json"]).default("plain"),
});

export type ScoutSourceOptions = z.infer<typeof scoutSourceOptionsSchema>;

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

export type ScoutSourceDeps = {
  loadIdentity?: typeof loadIdentityConfig;
  buildResolver?: typeof resolverForCanonicalId;
  repoPath?: string;
};

export class ScoutSourceError extends Error {}

/**
 * The reach: resolve the unit's source authority uniformly across GitHub /
 * beads / Notion. Scout owns this external-read capability; other actors (the
 * intake pin step) delegate to it rather than holding the resolver themselves.
 * Pure plumbing — injectable deps keep it testable offline.
 */
export async function resolveWorkUnitSource(
  id: string,
  deps: ScoutSourceDeps = {},
): Promise<ResolvedWorkUnit> {
  const loadIdentity = deps.loadIdentity ?? loadIdentityConfig;
  const buildResolver = deps.buildResolver ?? resolverForCanonicalId;
  const repoPath = deps.repoPath ?? process.cwd();

  const identity = loadIdentity(repoPath);
  const resolver = buildResolver(id, identity, repoPath);
  if (resolver === null) {
    throw new ScoutSourceError(
      `scout source: no source resolver configured for ${id} — configure a GitHub/Notion source or check the canonical id`,
    );
  }
  try {
    return await resolver.fetch(id);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new ScoutSourceError(
      `scout source: failed to resolve ${id} via ${resolver.name}: ${details}`,
    );
  }
}

/** `prx scout source <unit>` — print the resolved source authority (fetch only, no pin). */
export async function runScoutSource(
  options: ScoutSourceOptions,
  output: Output,
  deps: ScoutSourceDeps = {},
): Promise<number> {
  const resolved = await resolveWorkUnitSource(options.id, deps);
  if (options.format === "json") {
    output.log(
      JSON.stringify({
        unit: options.id,
        source: resolved.source,
        title: resolved.title,
        state: resolved.state,
        url: resolved.url,
        body: resolved.body,
      }),
    );
  } else {
    output.log(`${resolved.source}: ${resolved.title} [${resolved.state}]`);
    if (resolved.url) output.log(`  ${resolved.url}`);
  }
  return 0;
}
