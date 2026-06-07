---
---

internal: VerbSpec `parseArgs` now supports a variadic (array-typed) positional —
it collects every positional value and merges it with same-name flag occurrences
(`cmd a b --id c` → `[a, b, c]`), matching the legacy "positionals + repeated
flag" merge. Unblocks migrating handlers that take a list of positional args
(e.g. `pr-comments resolve <thread-id…>`). No package change.
