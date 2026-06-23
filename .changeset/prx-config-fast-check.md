---
"@bounded-systems/prx-config": patch
---

Add explicit `z.ZodType<T>` annotations to exported Zod schemas for JSR fast-check compliance. Add `| undefined` to optional TypeScript type fields to match `exactOptionalPropertyTypes: true` + Zod optional output.
