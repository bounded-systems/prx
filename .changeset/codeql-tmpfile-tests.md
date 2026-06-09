---
---

test-only: replace hardcoded `/tmp/...` argv literals in CLI tests with relative/temp-dir paths, eliminating the CodeQL `js/insecure-temporary-file` (CWE-377) false positive on `cli/plugin-emit.ts` (the generic orchestrator dispatch flowed those literals into its writeFile). No shipped-code change. Verified locally: the query reports 0 results after the change.
