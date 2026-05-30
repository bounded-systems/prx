// Caching layer over the proc contract.
//
// The async migration multiplies nested subprocess calls (one `git rev-parse`
// per candidate, etc.). Because ProcExecutor is a port, caching is a decorator:
// repeated *pure-read* requests return a cached ProcResult instead of
// re-spawning. Invalidation is coarse and lazy — bump the layer (the state it
// reads changed) and entries re-derive on next access. "Invalidate the layer
// and let the concern handle itself."
//
// Cacheability is derived from @bounded-systems/policy: only requests whose command is a
// policy tool running an unconditional read subcommand (and carrying no
// mutating subcommand token) are cached. Mutations pass straight through.
//
// Cache keys are the canonical-JSON of the request today; when proc I/O moves
// to CAS, the key becomes the request digest and the value a CAS blob — a
// cached proc run is then an anchored-chain derivation.
import { isKnownSubcommand, isPolicyTool, isReadOnly, type PolicyTool } from "@bounded-systems/policy";

import type { ProcExecutor, ProcRequest, ProcResult } from "./contract.ts";
import { procRequestSchema } from "./contract.ts";

export interface ProcCache {
  get(key: string): ProcResult | undefined;
  set(key: string, value: ProcResult): void;
  clear(): void;
}

export function inMemoryProcCache(): ProcCache {
  const map = new Map<string, ProcResult>();
  return {
    get: (k) => map.get(k),
    set: (k, v) => void map.set(k, v),
    clear: () => map.clear(),
  };
}

/** Default cacheability: a policy-tool pure read with no mutating token. */
export function policyCacheable(req: ProcRequest): boolean {
  if (!isPolicyTool(req.command)) return false;
  const tool = req.command as PolicyTool;
  const args = req.args ?? [];
  // Any known-but-not-read token (a mutation) disqualifies the whole request.
  if (args.some((a) => isKnownSubcommand(tool, a) && !isReadOnly(tool, a))) {
    return false;
  }
  return args.some((a) => isReadOnly(tool, a));
}

function cacheKey(req: ProcRequest): string {
  // Canonical, stable across key order. (Becomes a CAS digest when proc I/O
  // moves to content addressing.)
  return JSON.stringify({
    command: req.command,
    args: req.args ?? [],
    cwd: req.cwd ?? null,
    env: req.env ?? null,
    stdin: req.stdin ?? null,
    stdio: req.stdio ?? "pipe",
  });
}

export interface CachingProcExecutor extends ProcExecutor {
  /** Drop all cached results — the next read of each re-derives lazily. */
  invalidate(): void;
}

export interface CachingProcOptions {
  cache?: ProcCache;
  isCacheable?: (req: ProcRequest) => boolean;
}

export function cachingProcExecutor(
  inner: ProcExecutor,
  opts: CachingProcOptions = {},
): CachingProcExecutor {
  const cache = opts.cache ?? inMemoryProcCache();
  const isCacheable = opts.isCacheable ?? policyCacheable;
  return {
    async exec(request: ProcRequest): Promise<ProcResult> {
      const req = procRequestSchema.parse(request);
      if (req.stdio === "inherit" || !isCacheable(req)) {
        return inner.exec(req);
      }
      const key = cacheKey(req);
      const hit = cache.get(key);
      if (hit) return hit;
      const result = await inner.exec(req);
      // Only cache clean reads — a failed read is transient, not a fact.
      if (result.status === 0) cache.set(key, result);
      return result;
    },
    invalidate(): void {
      cache.clear();
    },
  };
}
