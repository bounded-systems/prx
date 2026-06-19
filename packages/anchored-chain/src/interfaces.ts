import type {
  ActionPlan,
  ApplyResult,
  ContractId,
  Digest,
  SurfaceRef,
  VerdictResult,
} from "./types.ts";

export interface Fetcher {
  fetch(ref: SurfaceRef): Promise<{
    digest: Digest;
    bytes: Uint8Array;
    freshnessSignal: string;
  }>;
  isFresh(ref: SurfaceRef, lastSignal: string): Promise<boolean>;
}

export interface Applier {
  apply(plan: ActionPlan): Promise<ApplyResult>;
}

export interface ContractRegistry {
  getValidator(artifactType: ContractId): (digest: Digest, bytes?: Uint8Array) => VerdictResult;
}
