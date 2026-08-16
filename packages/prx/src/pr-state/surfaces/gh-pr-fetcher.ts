/**
 * GH-1961: PR surface implementation of the `Fetcher` interface from
 * `@bounded-systems/anchored-chain`. Lives in `src/pr-state/` because the parity-chain
 * module is extractable — it never reaches outward to `gh`, octokit, or
 * pr-state. Wiring the GitHub PR surface through `Fetcher` keeps the
 * shell-out boundary outside the module.
 *
 * `fetch()` shells `gh pr view <unit> --json …` once and returns the
 * canonical-JSON-digest of the parsed payload plus the raw bytes a
 * `BlobStore` would put. `isFresh()` runs the cheap `--json updatedAt`
 * probe so callers can short-circuit before re-fetching the full payload.
 *
 * The `CommandRunner` is injected (default: `defaultRunner` from
 * `@bounded-systems/proc`) so tests and the fixture-mode example wire a
 * stubbed runner without touching the network.
 */
import { defaultRunner, type CommandRunner } from "@bounded-systems/proc";

import {
  canonicalJson,
  sha256Hex,
  type Digest,
  type Fetcher,
  type SurfaceRef,
} from "@bounded-systems/anchored-chain";

const PR_JSON_FIELDS =
  "number,title,url,isDraft,baseRefName,reviewDecision,mergeStateStatus,mergeable,autoMergeRequest,reviews,updatedAt";

const SURFACE_PREFIX = "pr/";

export interface GhPrFetcherOptions {
  readonly runner?: CommandRunner;
  readonly cwd?: string;
}

export function prSurfaceRef(unit: string): SurfaceRef {
  return { name: `${SURFACE_PREFIX}${unit}` };
}

export function unitFromSurfaceRef(ref: SurfaceRef): string {
  if (!ref.name.startsWith(SURFACE_PREFIX)) {
    throw new Error(
      `unitFromSurfaceRef: expected ref name to start with "${SURFACE_PREFIX}", got "${ref.name}"`,
    );
  }
  return ref.name.slice(SURFACE_PREFIX.length);
}

export function createGhPrFetcher(opts: GhPrFetcherOptions = {}): Fetcher {
  const runner = opts.runner ?? defaultRunner;
  const cwd = opts.cwd;

  return {
    async fetch(ref) {
      const unit = unitFromSurfaceRef(ref);
      const result = runner(["gh", "pr", "view", unit, "--json", PR_JSON_FIELDS], {
        ...(cwd !== undefined ? { cwd } : {}),
      });
      const parsed = JSON.parse(result.stdout) as { updatedAt?: unknown };
      const canonical = canonicalJson(parsed);
      const bytes = new TextEncoder().encode(canonical);
      const digest: Digest = sha256Hex(canonical);
      const updatedAt = parsed.updatedAt;
      if (typeof updatedAt !== "string") {
        throw new Error(`gh-pr-fetcher: response for ${ref.name} is missing string updatedAt`);
      }
      return { digest, bytes, freshnessSignal: updatedAt };
    },
    async isFresh(ref, lastSignal) {
      const unit = unitFromSurfaceRef(ref);
      const result = runner(["gh", "pr", "view", unit, "--json", "updatedAt"], {
        ...(cwd !== undefined ? { cwd } : {}),
      });
      const parsed = JSON.parse(result.stdout) as { updatedAt?: unknown };
      return parsed.updatedAt === lastSignal;
    },
  };
}
