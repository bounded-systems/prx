// Leaf constants for the sync tick. Kept dependency-free so the value is always
// initialized regardless of module-load order — `src/triage/apply.ts` imports
// DEFAULT_SYNC_LIMIT through the apply↔sync↔triage import cycle, and sourcing it
// from a leaf (rather than the cycle-bound sync/run.ts body) removes a
// load-order-dependent temporal-dead-zone on the binding.
export const DEFAULT_SYNC_LIMIT = 50;
