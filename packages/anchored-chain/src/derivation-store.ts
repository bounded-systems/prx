import type { Derivation, Digest } from "./types.ts";

export interface DerivationInputRow {
  readonly inputName: string;
  readonly inputDigest: Digest;
}

export interface DerivationOutputRow {
  readonly outputName: string;
  readonly outputDigest: Digest;
}

export interface DerivationStore {
  append(derivation: Derivation): Promise<void>;
  get(derivationId: Digest): Promise<Derivation | null>;
  listInputs(derivationId: Digest): Promise<readonly DerivationInputRow[]>;
  listOutputs(derivationId: Digest): Promise<readonly DerivationOutputRow[]>;
  /**
   * Reverse lookup: the ids of derivations that *produced* the given output
   * digest. The inverse of {@link listOutputs}. Lets a caller enumerate the
   * derivations attesting an artifact (e.g. every `push/v1` derivation whose
   * subject is a head commit `gitCommit:<oid>`) so they can be re-verified —
   * the seam GH-2249 merge-guard enforcement reads. Returns distinct ids; an
   * output with no producing derivation yields an empty list.
   */
  derivationsByOutput(outputDigest: Digest): Promise<readonly Digest[]>;
}
