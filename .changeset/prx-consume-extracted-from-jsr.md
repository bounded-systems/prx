---
"@bounded-systems/prx": patch
---

Consume the extracted `@bounded-systems/*` libraries from JSR instead of carrying duplicate workspace copies. The 21 leaf + non-leaf packages now live in their own repos (JSR-linked); `packages/*` no longer vendors them. Internal restructure only — the prx CLI's behavior is unchanged. `anchored-chain-sqlite`'s migration generator moved into its own repo; the orphaned `gen-acs-migrations.ts` + `acs:migrations` scripts are removed from prx.
