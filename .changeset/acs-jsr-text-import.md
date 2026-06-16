---
"@bounded-systems/anchored-chain-sqlite": patch
---

Embed migration SQL via a generated `migrations.generated.ts` constant instead of `import ... with { type: "text" }`, which JSR rejects — makes the package JSR-publishable. The .sql files stay drizzle's source of truth (a drift-guarded codegen step embeds them); the compiled-binary materialization path is unchanged.
