import type { ContractRegistry } from "./interfaces.ts";
import type { AnchoredChainStore } from "./store.ts";
import type { ContractId, Digest } from "./types.ts";

export interface GuardCtx {
  readonly store: AnchoredChainStore;
  readonly registry: ContractRegistry;
}

export type GuardResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

// Zero-arg by design: a GuardFn has no input channel for caller-supplied
// state. This signature is the type-level enforcement of spike invariant #2
// — the only way for a guard to know about the world is via the store
// closed over at factory time.
export type GuardFn = () => Promise<GuardResult>;

export function refAtDigest(ctx: GuardCtx, refName: string, expected: Digest): GuardFn {
  return async () => {
    const ref = await ctx.store.refs.get(refName);
    if (ref === null) {
      return { ok: false, reason: `ref not found: ${refName}` };
    }
    if (ref.digest !== expected) {
      return {
        ok: false,
        reason: `digest mismatch on ${refName}: expected ${expected}, actual ${ref.digest}`,
      };
    }
    return { ok: true };
  };
}

export function refIsFresh(ctx: GuardCtx, refName: string): GuardFn {
  return async () => {
    const cached = await ctx.store.refs.get(refName);
    if (cached === null) {
      return { ok: false, reason: `ref not found: ${refName}` };
    }
    const derivation = await ctx.store.derivations.get(cached.digest);
    if (derivation === null) {
      return {
        ok: false,
        reason: `derivation not found for ${refName}: ${cached.digest}`,
      };
    }
    for (const inputKey of Object.keys(derivation.manifest.inputs)) {
      const inputRef = await ctx.store.refs.get(inputKey);
      if (inputRef === null) continue;
      if (inputRef.ts > cached.ts) {
        return {
          ok: false,
          reason: `stale: input ${inputKey} ts=${inputRef.ts} > cached ts=${cached.ts}`,
        };
      }
    }
    return { ok: true };
  };
}

export function contractHolds(ctx: GuardCtx, refName: string, contract: ContractId): GuardFn {
  return async () => {
    const ref = await ctx.store.refs.get(refName);
    if (ref === null) {
      return { ok: false, reason: `ref not found: ${refName}` };
    }
    const validator = ctx.registry.getValidator(contract);
    const result = validator(ref.digest, undefined);
    if (!result.ok) {
      return {
        ok: false,
        reason: `${contract}: ${result.reason ?? "validator returned ok=false"}`,
      };
    }
    return { ok: true };
  };
}
