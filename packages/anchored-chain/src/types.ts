import type { DsseEnvelope } from "./in-toto.ts";

// The content address is owned by the CAS substrate; anchored-chain builds its
// derivation/ref graph on top of it and re-exposes the type as part of its own
// public surface (a Ref/Derivation is made of Digests).
import type { Digest } from "@bounded-systems/cas";
export type { Digest };

export type ContractId = string & { readonly __brand: "ContractId" };

export interface Ref {
  readonly name: string;
  readonly digest: Digest;
  readonly ts: number;
}

export interface RefLogEntry {
  readonly name: string;
  readonly prevDigest: Digest | null;
  readonly newDigest: Digest;
  readonly reason: string;
  readonly ts: number;
}

export interface Derivation {
  readonly derivationId: Digest;
  readonly manifest: {
    readonly producer: string;
    readonly inputs: Readonly<Record<string, Digest>>;
    readonly outputs: Readonly<Record<string, Digest>>;
    readonly contracts: readonly string[];
    readonly params: Readonly<Record<string, unknown>>;
  };
  // Optional DSSE-signed in-toto Statement over this derivation. Absent =
  // unsigned (content-addressed integrity only). Present = authenticated
  // provenance, verifiable via a `Verifier` in `validateDerivation`.
  readonly envelope?: DsseEnvelope;
  readonly ts: number;
}

export interface SurfaceRef {
  readonly name: string;
}

export interface ActionPlan {
  readonly producer: string;
}

export interface ApplyResult {
  readonly ok: boolean;
}

export interface VerdictResult {
  readonly ok: boolean;
  readonly reason?: string;
}
