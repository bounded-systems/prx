/**
 * GH-1961 — end-to-end wiring example for the `Fetcher` boundary.
 *
 * This file is the executable form of the spike's exit-criterion-2 demo:
 * given any `Fetcher` (the caller supplies a real PR fetcher, an HTTP
 * fetcher, or a fixture-stubbed one) and a `AnchoredChainStore`, advance
 * `pr/<unit>` via CAS and append a `Derivation` whose manifest digest
 * is reproducible across runs.
 *
 * Imports stay relative to siblings inside the parity-chain module —
 * the extractability test (`__tests__/extractability.test.ts`) forbids
 * outbound deps and treats `__examples__/` as production code. The
 * example never imports a concrete fetcher; it receives one through
 * `args.fetcher` so the module can be lifted into a separate package
 * without rewriting the example.
 */
import { digestManifest, invalidateDescendants } from "@bounded-systems/anchored-chain";
import type {
  AnchoredChainStore,
  Derivation,
  Digest,
  Fetcher,
  SurfaceRef,
} from "@bounded-systems/anchored-chain";
import { sha256Hex } from "@bounded-systems/cas";

export interface RunPrEndToEndArgs {
  readonly store: AnchoredChainStore;
  readonly fetcher: Fetcher;
  readonly surface: SurfaceRef;
  readonly now: number;
  readonly producer?: string;
}

export interface RunPrEndToEndResult {
  readonly appended: boolean;
  readonly refDigest: Digest;
  readonly derivationId: Digest;
  readonly freshnessSignal: string;
  readonly invalidated: readonly Digest[];
}

const DEFAULT_PRODUCER = "fetcher:gh-pr";

export async function runPrEndToEnd(args: RunPrEndToEndArgs): Promise<RunPrEndToEndResult> {
  const { store, fetcher, surface, now } = args;
  const producer = args.producer ?? DEFAULT_PRODUCER;

  const fetched = await fetcher.fetch(surface);
  const surfaceInputDigest = sha256Hex(surface.name);

  const manifest: Derivation["manifest"] = {
    producer,
    inputs: { surface: surfaceInputDigest },
    outputs: { pr: fetched.digest },
    contracts: [],
    params: {
      freshnessSignal: fetched.freshnessSignal,
      refName: surface.name,
    },
  };
  const derivationId = digestManifest(manifest);

  const existing = await store.derivations.get(derivationId);
  const prior = await store.refs.get(surface.name);

  if (existing) {
    return {
      appended: false,
      refDigest: prior?.digest ?? fetched.digest,
      derivationId,
      freshnessSignal: fetched.freshnessSignal,
      invalidated: [],
    };
  }

  await store.refs.cas({
    name: surface.name,
    prevDigest: prior?.digest ?? null,
    newDigest: fetched.digest,
    reason: producer,
    ts: now,
  });
  await store.derivations.append({ derivationId, manifest, ts: now });

  const invalidated = prior ? await invalidateDescendants(store, prior.digest) : [];

  return {
    appended: true,
    refDigest: fetched.digest,
    derivationId,
    freshnessSignal: fetched.freshnessSignal,
    invalidated,
  };
}
