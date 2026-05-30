// GH-2096 — `@bounded-systems/machine-schema` package shell. First real consumer
// is the GH-1397 handoff envelope; GH-2097 lifts the schema/phase/invariant
// primitives out of `src/machine/state.ts` (which becomes a one-release shim).
export * from "./brands.ts";
export * from "./handoff.ts";
export * from "./state.ts";
