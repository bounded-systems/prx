// dependency-cruiser — the modern madge replacement, and the place the project's
// MODULE ARCHITECTURE becomes enforceable instead of aspirational.
//
//   bunx depcruise packages --config .dependency-cruiser.cjs
//
// Target architecture (bobby's rule): "parents import children; shared lives in
// one global module; you always click DOWN, never up." Formally that is an
// ACYCLIC, downward dependency graph with a single shared sink. The rules below
// grade progress toward it. They are `warn`/`info` today (a measurable backlog —
// see docs/code-health.md); flip each to `error` once its count hits zero to
// lock the property in.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      // The headline symptom of "importing upward": if every import pointed DOWN
      // (parent → child), the graph would be acyclic. Every cycle is an up-edge.
      name: "no-circular",
      comment: "Circular import — a parent and a descendant import each other. Click-down is broken.",
      severity: "warn",
      from: {},
      to: { circular: true },
    },
    {
      // "shared is a global module": src/lib is the sink — everything may import
      // it; it may import nothing app-specific (only node/capability packages).
      name: "shared-stays-pure",
      comment: "src/lib is the shared sink; it must not import feature code (that would make it not-shared).",
      severity: "warn",
      from: { path: "^packages/prx/src/lib/" },
      to: {
        path: "^packages/prx/src/",
        pathNot: ["^packages/prx/src/lib/", "\\.test\\.ts$"],
      },
    },
    {
      name: "no-orphans",
      comment: "Orphan module — unreachable; candidate for deletion (cross-check `knip`).",
      severity: "info",
      from: { orphan: true, pathNot: ["\\.(test|d)\\.ts$", "(^|/)(index|cli)\\.ts$"] },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    includeOnly: "^packages/",
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "require"] },
  },
};
