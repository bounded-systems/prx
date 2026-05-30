/**
 * @bounded-systems/anchored-chain-sqlite — the SQLite/Drizzle-backed implementation of the
 * anchored-chain stores (RefStore, DerivationStore) plus lineage/invalidation
 * over a real database. This is where bun:sqlite + drizzle-orm live, kept out
 * of the pure @bounded-systems/anchored-chain core so consumers that only need the
 * algorithms or contracts never pull a database dependency.
 *
 * Re-exports the core surface so a store consumer has a single import; core-only
 * consumers should import @bounded-systems/anchored-chain directly (no drizzle).
 */
export * from "@bounded-systems/anchored-chain";
export { openAnchoredChain } from "./store.ts";
export { runPrEndToEnd } from "./__examples__/pr-end-to-end.ts";
export type {
  RunPrEndToEndArgs,
  RunPrEndToEndResult,
} from "./__examples__/pr-end-to-end.ts";
