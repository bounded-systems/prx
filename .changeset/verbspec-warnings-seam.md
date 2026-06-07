---
---

internal: add the `warnings` projection to the VerbSpec spine — optional stderr
lines (operator warnings/notes/diagnostics) a successful run emits alongside its
stdout result. The bridge writes them to stderr before `render`. CLI-only;
MCP/OpenAPI consume `output`. Unblocks migrating the two-stream handlers
(plan-save/load/show, version, check-*) that wrote to both stdout and stderr.
No package change.
