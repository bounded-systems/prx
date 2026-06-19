import type { Digest, Ref, RefLogEntry } from "./types.ts";

export interface RefStore {
  get(name: string): Promise<Ref | null>;
  cas(args: {
    name: string;
    prevDigest: Digest | null;
    newDigest: Digest;
    reason: string;
    ts: number;
  }): Promise<Ref>;
  asOf(name: string, ts: number): Promise<RefLogEntry | null>;
  log(name: string): Promise<readonly RefLogEntry[]>;
}

export class RefMismatchError extends Error {
  readonly name = "RefMismatchError";
  readonly refName: string;
  readonly expectedPrev: Digest | null;
  readonly actual: Digest | null;

  constructor(args: {
    refName: string;
    expectedPrev: Digest | null;
    actual: Digest | null;
  }) {
    super(
      `ref CAS mismatch on "${args.refName}": expected prev=${args.expectedPrev ?? "null"}, actual=${args.actual ?? "null"}`,
    );
    this.refName = args.refName;
    this.expectedPrev = args.expectedPrev;
    this.actual = args.actual;
  }
}
